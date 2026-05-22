import path from "node:path";
import {
  createId,
  nowIso,
  wakeRequestSchema,
  type Agent,
  type Run,
  type RunEvent,
  type RuntimeWakePayload,
  type Task,
  type WakeRequest,
  type Workspace,
} from "@poc/shared";
import type { SandboxProvider } from "@poc/sandbox";
import type { JsonStore } from "../db/store.js";
import { materializeRunFilesystem } from "./workspace-materializer.js";

export type RunService = ReturnType<typeof createRunService>;

function formatErrorMessage(error: unknown) {
  let message: string;
  if (error instanceof Error) {
    message = error.message;
  } else if (error && typeof error === "object" && "message" in error && typeof error.message === "string") {
    message = error.message;
  } else if (typeof error === "string") {
    message = error;
  } else {
    try {
      message = JSON.stringify(error);
    } catch {
      message = String(error);
    }
  }
  return message.replace(/(?:dtn|sk|sk-proj|e2b|bl|adt)_[A-Za-z0-9_-]+/g, "[redacted]");
}

export function createRunService(input: {
  repoRoot: string;
  dataDir: string;
  controlPlaneUrl: string;
  sharedBundleVersion: string;
  provider: SandboxProvider;
  createProvider?: (providerName: SandboxProvider["name"]) => SandboxProvider;
  store: JsonStore;
}) {
  const running = new Map<string, Promise<Run>>();

  async function ensureAgent(agentId: string): Promise<Agent> {
    const existing = input.store.getAgent(agentId);
    if (existing) return existing;
    const agent = { id: agentId, createdAt: nowIso() };
    await input.store.upsertAgent(agent);
    return agent;
  }

  async function ensureWorkspace(workspaceId: string): Promise<Workspace> {
    const existing = input.store.getWorkspace(workspaceId);
    if (existing) return existing;
    const workspace = { id: workspaceId, createdAt: nowIso() };
    await input.store.upsertWorkspace(workspace);
    return workspace;
  }

  async function createTaskForWake(wakeEventId: string, request: WakeRequest): Promise<Task> {
    const now = nowIso();
    const task: Task = {
      id: request.taskId ?? createId("task"),
      agentId: request.agentId,
      workspaceId: request.workspaceId,
      title: request.message.split(/\r?\n/)[0]?.slice(0, 120) || "Wake task",
      body: request.message,
      status: "todo",
      priority: 0,
      createdFromEventId: wakeEventId,
      createdAt: now,
      updatedAt: now,
    };
    if (!input.store.getTask(task.id)) {
      await input.store.insertTask(task);
    }
    return input.store.getTask(task.id) ?? task;
  }

  async function recordEvent(event: RunEvent) {
    await input.store.appendRunEvent(event);
    if (event.type === "task_updated") {
      await input.store.updateTaskStatus(event.taskId, event.status, event.timestamp);
    }
  }

  async function executeRun(
    run: Run,
    wakeEvent: RuntimeWakePayload["wakeEvent"],
    task: Task | undefined,
    provider: SandboxProvider,
  ): Promise<Run> {
    let currentRun: Run = { ...run, status: "starting_sandbox", startedAt: nowIso() };
    await input.store.updateRun(currentRun);

    const fs = await materializeRunFilesystem({
      repoRoot: input.repoRoot,
      dataDir: input.dataDir,
      agentId: run.agentId,
      workspaceId: run.workspaceId,
      runId: run.id,
      sharedBundleVersion: run.sharedBundleVersion,
      wakePayload: {
        run: currentRun,
        wakeEvent,
        task,
      },
    });

    let handle;
    try {
      handle = await provider.startRun({
        runId: run.id,
        agentId: run.agentId,
        workspaceId: run.workspaceId,
        agentHomePath: fs.agentHomePath,
        workspacePath: fs.workspacePath,
        sharedPath: fs.sharedPath,
        runPath: fs.runPath,
        wakePath: fs.wakePath,
      });
    } catch (error) {
      const message = formatErrorMessage(error);
      await recordEvent({ type: "run_finished", runId: run.id, timestamp: nowIso(), status: "failed", error: message });
      currentRun = { ...currentRun, status: "failed", finishedAt: nowIso(), error: message };
      await input.store.updateRun(currentRun);
      return currentRun;
    }
    await recordEvent({
      type: "sandbox_started",
      runId: run.id,
      timestamp: nowIso(),
      provider: handle.provider,
      sandboxId: handle.sandboxId,
    });

    currentRun = { ...currentRun, status: "running" };
    await input.store.updateRun(currentRun);

    const payload: RuntimeWakePayload = {
      run: currentRun,
      wakeEvent,
      ...(task ? { task } : {}),
      agentHomePath: handle.runtimePaths?.agentHomePath ?? fs.agentHomePath,
      workspacePath: handle.runtimePaths?.workspacePath ?? fs.workspacePath,
      sharedPath: handle.runtimePaths?.sharedPath ?? fs.sharedPath,
      controlPlaneApiUrl: input.controlPlaneUrl,
      runToken: handle.runtimePaths?.wakePath ?? fs.wakePath,
    };

    async function markRunFailed(error: string, timestamp = nowIso()) {
      if (task) {
        const currentTask = input.store.getTask(task.id);
        if (currentTask && currentTask.status !== task.status) {
          await input.store.updateTaskStatus(task.id, task.status, timestamp);
        }
      }
      currentRun = { ...currentRun, status: "failed", finishedAt: timestamp, error };
      await input.store.updateRun(currentRun);
    }

    try {
      let runtimeFinish: Extract<RunEvent, { type: "run_finished" }> | undefined;
      for await (const event of provider.exec({ handle, payload })) {
        await recordEvent(event);
        if (event.type === "run_finished") {
          runtimeFinish = event;
        }
      }
      if (runtimeFinish?.status === "failed") {
        await markRunFailed(runtimeFinish.error ?? "Runtime reported failure", runtimeFinish.timestamp);
      } else {
        currentRun = { ...currentRun, status: "succeeded", finishedAt: runtimeFinish?.timestamp ?? nowIso() };
        await input.store.updateRun(currentRun);
      }
    } catch (error) {
      const message = formatErrorMessage(error);
      await recordEvent({ type: "run_finished", runId: run.id, timestamp: nowIso(), status: "failed", error: message });
      await markRunFailed(message);
    } finally {
      await provider.stop(handle);
      await recordEvent({ type: "sandbox_stopped", runId: run.id, timestamp: nowIso(), sandboxId: handle.sandboxId });
    }

    return currentRun;
  }

  async function wake(rawRequest: unknown) {
    const request = wakeRequestSchema.parse(rawRequest);
    await ensureAgent(request.agentId);
    await ensureWorkspace(request.workspaceId);

    const wakeEvent = {
      id: createId("wake"),
      source: request.source,
      agentId: request.agentId,
      workspaceId: request.workspaceId,
      message: request.message,
      ...(request.taskId ? { taskId: request.taskId } : {}),
      ...(request.conversationId ? { conversationId: request.conversationId } : {}),
      ...(request.idempotencyKey ? { idempotencyKey: request.idempotencyKey } : {}),
      ...(request.metadata ? { metadata: request.metadata } : {}),
      createdAt: nowIso(),
    };
    await input.store.insertWakeEvent(wakeEvent);

    const task = await createTaskForWake(wakeEvent.id, request);
    const provider = request.sandboxProvider ? (input.createProvider?.(request.sandboxProvider) ?? input.provider) : input.provider;
    const run: Run = {
      id: createId("run"),
      wakeEventId: wakeEvent.id,
      agentId: request.agentId,
      workspaceId: request.workspaceId,
      taskId: task.id,
      sandboxProvider: provider.name,
      sharedBundleVersion: input.sharedBundleVersion,
      status: "queued",
    };
    await input.store.insertRun(run);
    await recordEvent({ type: "wake_received", runId: run.id, timestamp: nowIso(), message: request.message });
    await recordEvent({ type: "run_created", runId: run.id, timestamp: nowIso() });

    const promise = executeRun(run, wakeEvent, task, provider);
    running.set(run.id, promise);
    promise.finally(() => running.delete(run.id)).catch(() => undefined);

    return {
      runId: run.id,
      eventStreamUrl: `/runs/${run.id}/events`,
    };
  }

  async function chatTurn(rawRequest: unknown) {
    const wakeResponse = await wake(rawRequest);
    const run = await waitForRun(wakeResponse.runId);
    const events = input.store.listRunEvents(wakeResponse.runId);
    const assistantMessage =
      [...events].reverse().find((event): event is Extract<RunEvent, { type: "assistant_message" }> => event.type === "assistant_message")
        ?.content ?? "";
    return {
      run,
      assistantMessage,
      events,
      eventStreamUrl: wakeResponse.eventStreamUrl,
    };
  }

  async function waitForRun(runId: string): Promise<Run> {
    const active = running.get(runId);
    if (active) return active;
    const run = input.store.getRun(runId);
    if (!run) throw new Error(`Run not found: ${runId}`);
    return run;
  }

  return {
    wake,
    chatTurn,
    waitForRun,
    getRun: (runId: string) => input.store.getRun(runId),
    listRunEvents: (runId: string) => input.store.listRunEvents(runId),
    listTasks: () => input.store.listTasks(),
    store: input.store,
  };
}
