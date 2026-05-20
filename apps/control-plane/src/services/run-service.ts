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

export function createRunService(input: {
  repoRoot: string;
  dataDir: string;
  controlPlaneUrl: string;
  sharedBundleVersion: string;
  provider: SandboxProvider;
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

  async function executeRun(run: Run, wakeEvent: RuntimeWakePayload["wakeEvent"], task: Task | undefined): Promise<Run> {
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

    const handle = await input.provider.startRun({
      runId: run.id,
      agentId: run.agentId,
      workspaceId: run.workspaceId,
      agentHomePath: fs.agentHomePath,
      workspacePath: fs.workspacePath,
      sharedPath: fs.sharedPath,
      runPath: fs.runPath,
      wakePath: fs.wakePath,
    });
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

    try {
      for await (const event of input.provider.exec({ handle, payload })) {
        await recordEvent(event);
      }
      currentRun = { ...currentRun, status: "succeeded", finishedAt: nowIso() };
      await input.store.updateRun(currentRun);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await recordEvent({ type: "run_finished", runId: run.id, timestamp: nowIso(), status: "failed", error: message });
      currentRun = { ...currentRun, status: "failed", finishedAt: nowIso(), error: message };
      await input.store.updateRun(currentRun);
    } finally {
      await input.provider.stop(handle);
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
    const run: Run = {
      id: createId("run"),
      wakeEventId: wakeEvent.id,
      agentId: request.agentId,
      workspaceId: request.workspaceId,
      taskId: task.id,
      sandboxProvider: input.provider.name,
      sharedBundleVersion: input.sharedBundleVersion,
      status: "queued",
    };
    await input.store.insertRun(run);
    await recordEvent({ type: "wake_received", runId: run.id, timestamp: nowIso(), message: request.message });
    await recordEvent({ type: "run_created", runId: run.id, timestamp: nowIso() });

    const promise = executeRun(run, wakeEvent, task);
    running.set(run.id, promise);
    promise.finally(() => running.delete(run.id)).catch(() => undefined);

    return {
      runId: run.id,
      eventStreamUrl: `/runs/${run.id}/events`,
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
    waitForRun,
    getRun: (runId: string) => input.store.getRun(runId),
    listRunEvents: (runId: string) => input.store.listRunEvents(runId),
    listTasks: () => input.store.listTasks(),
    store: input.store,
  };
}
