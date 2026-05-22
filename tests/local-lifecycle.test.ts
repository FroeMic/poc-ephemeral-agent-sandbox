import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, test } from "vitest";
import { createRunService } from "../apps/control-plane/src/services/run-service.js";
import { JsonStore } from "../apps/control-plane/src/db/store.js";
import { LocalSandboxProvider } from "../packages/sandbox/src/local-provider.js";
import type { ExecInput, SandboxHandle, SandboxProvider, StartRunInput } from "../packages/sandbox/src/types.js";

const tempDirs: string[] = [];

async function makeTempDir() {
  const dir = await mkdtemp(path.join(os.tmpdir(), "poc-lifecycle-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

class FailingSandboxProvider implements SandboxProvider {
  readonly name = "daytona" as const;
  stopped: SandboxHandle[] = [];

  async startRun(input: StartRunInput): Promise<SandboxHandle> {
    return {
      provider: this.name,
      sandboxId: `failing-${input.runId}`,
    };
  }

  async *exec(_input: ExecInput) {
    throw new Error("runtime exploded");
  }

  async stop(handle: SandboxHandle): Promise<void> {
    this.stopped.push(handle);
  }
}

class FailingStartSandboxProvider implements SandboxProvider {
  readonly name = "daytona" as const;
  stopped: SandboxHandle[] = [];

  async startRun(_input: StartRunInput): Promise<SandboxHandle> {
    throw new Error("sandbox create exploded");
  }

  async *exec(_input: ExecInput) {
    throw new Error("should not execute");
  }

  async stop(handle: SandboxHandle): Promise<void> {
    this.stopped.push(handle);
  }
}

class FailedEventSandboxProvider implements SandboxProvider {
  readonly name = "daytona" as const;
  stopped: SandboxHandle[] = [];

  async startRun(input: StartRunInput): Promise<SandboxHandle> {
    return {
      provider: this.name,
      sandboxId: `failed-event-${input.runId}`,
    };
  }

  async *exec(input: ExecInput) {
    yield {
      type: "run_finished" as const,
      runId: input.payload.run.id,
      timestamp: "2026-05-20T00:00:00.000Z",
      status: "failed" as const,
      error: "runtime reported failure",
    };
  }

  async stop(handle: SandboxHandle): Promise<void> {
    this.stopped.push(handle);
  }
}

class DoneThenFailingSandboxProvider implements SandboxProvider {
  readonly name = "daytona" as const;
  stopped: SandboxHandle[] = [];

  async startRun(input: StartRunInput): Promise<SandboxHandle> {
    return {
      provider: this.name,
      sandboxId: `done-then-failing-${input.runId}`,
    };
  }

  async *exec(input: ExecInput) {
    yield {
      type: "task_updated" as const,
      runId: input.payload.run.id,
      timestamp: "2026-05-20T00:00:00.000Z",
      taskId: input.payload.run.taskId!,
      status: "done" as const,
    };
    throw new Error("runtime failed after task update");
  }

  async stop(handle: SandboxHandle): Promise<void> {
    this.stopped.push(handle);
  }
}

test("runs the local sandbox lifecycle and preserves workspace state across runs", async () => {
  const dataDir = await makeTempDir();
  const store = await JsonStore.create(path.join(dataDir, "store.json"));
  const service = createRunService({
    repoRoot: process.cwd(),
    dataDir,
    controlPlaneUrl: "http://127.0.0.1:3000",
    sharedBundleVersion: "v1",
    provider: new LocalSandboxProvider({ repoRoot: process.cwd() }),
    store,
  });

  const first = await service.wake({
    source: "api",
    agentId: "agent-main",
    workspaceId: "workspace-demo",
    message: "Create the first durable note",
  });
  await service.waitForRun(first.runId);

  const second = await service.wake({
    source: "api",
    agentId: "agent-main",
    workspaceId: "workspace-demo",
    message: "Create the second durable note",
  });
  const completed = await service.waitForRun(second.runId);

  expect(completed.status).toBe("succeeded");
  const workspacePath = path.join(dataDir, "workspaces", "workspace-demo");
  await expect(readFile(path.join(workspacePath, "notes", `${first.runId}.md`), "utf8")).resolves.toContain(
    "Create the first durable note",
  );
  await expect(readFile(path.join(workspacePath, "notes", `${second.runId}.md`), "utf8")).resolves.toContain(
    "Create the second durable note",
  );

  const events = store.listRunEvents(second.runId);
  expect(events.map((event) => event.type)).toContain("sandbox_started");
  expect(events.map((event) => event.type)).toContain("run_finished");
});

test("returns a completed chat turn with run events", async () => {
  const dataDir = await makeTempDir();
  const store = await JsonStore.create(path.join(dataDir, "store.json"));
  const service = createRunService({
    repoRoot: process.cwd(),
    dataDir,
    controlPlaneUrl: "http://127.0.0.1:3000",
    sharedBundleVersion: "v1",
    provider: new LocalSandboxProvider({ repoRoot: process.cwd() }),
    store,
  });

  const turn = await service.chatTurn({
    source: "chat",
    agentId: "support-agent",
    workspaceId: "support-workspace",
    message: "hello from chat",
  });

  expect(turn.run.agentId).toBe("support-agent");
  expect(turn.run.status).toBe("succeeded");
  expect(turn.assistantMessage).toContain("hello from chat");
  expect(turn.events).toContainEqual(
    expect.objectContaining({
      type: "assistant_message",
      content: expect.stringContaining("hello from chat"),
    }),
  );
  expect(turn.events.map((event) => event.type)).toContain("run_finished");
});

test("uses the request-selected sandbox provider for a chat turn", async () => {
  const dataDir = await makeTempDir();
  const store = await JsonStore.create(path.join(dataDir, "store.json"));
  const localProvider = new LocalSandboxProvider({ repoRoot: process.cwd() });
  const daytonaProvider = new FailedEventSandboxProvider();
  const requestedProviders: string[] = [];
  const service = createRunService({
    repoRoot: process.cwd(),
    dataDir,
    controlPlaneUrl: "http://127.0.0.1:3000",
    sharedBundleVersion: "v1",
    provider: localProvider,
    createProvider: (name) => {
      requestedProviders.push(name);
      return name === "daytona" ? daytonaProvider : localProvider;
    },
    store,
  });

  const turn = await service.chatTurn({
    source: "chat",
    agentId: "support-agent",
    workspaceId: "support-workspace",
    sandboxProvider: "daytona",
    message: "use daytona",
  });

  expect(requestedProviders).toEqual(["daytona"]);
  expect(turn.run.sandboxProvider).toBe("daytona");
  expect(turn.events).toContainEqual(expect.objectContaining({ type: "sandbox_started", provider: "daytona" }));
});

test("stops the sandbox and records failure events when runtime execution fails", async () => {
  const dataDir = await makeTempDir();
  const store = await JsonStore.create(path.join(dataDir, "store.json"));
  const provider = new FailingSandboxProvider();
  const service = createRunService({
    repoRoot: process.cwd(),
    dataDir,
    controlPlaneUrl: "http://127.0.0.1:3000",
    sharedBundleVersion: "v1",
    provider,
    store,
  });

  const wake = await service.wake({
    source: "api",
    agentId: "agent-main",
    workspaceId: "workspace-demo",
    message: "This run should fail",
  });
  const completed = await service.waitForRun(wake.runId);

  expect(completed.status).toBe("failed");
  expect(completed.error).toBe("runtime exploded");
  expect(provider.stopped).toEqual([
    expect.objectContaining({
      provider: "daytona",
      sandboxId: `failing-${wake.runId}`,
    }),
  ]);
  expect(store.listRunEvents(wake.runId).map((event) => event.type)).toEqual(
    expect.arrayContaining(["sandbox_started", "run_finished", "sandbox_stopped"]),
  );
});

test("records a failed run when sandbox startup fails before a handle exists", async () => {
  const dataDir = await makeTempDir();
  const store = await JsonStore.create(path.join(dataDir, "store.json"));
  const provider = new FailingStartSandboxProvider();
  const service = createRunService({
    repoRoot: process.cwd(),
    dataDir,
    controlPlaneUrl: "http://127.0.0.1:3000",
    sharedBundleVersion: "v1",
    provider,
    store,
  });

  const wake = await service.wake({
    source: "api",
    agentId: "agent-main",
    workspaceId: "workspace-demo",
    message: "This sandbox should fail to start",
  });
  const completed = await service.waitForRun(wake.runId);

  expect(completed.status).toBe("failed");
  expect(completed.error).toBe("sandbox create exploded");
  expect(provider.stopped).toEqual([]);
  expect(store.listRunEvents(wake.runId)).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ type: "run_finished", status: "failed", error: "sandbox create exploded" }),
    ]),
  );
});

test("records useful details when sandbox startup throws a plain object", async () => {
  class ObjectThrowingProvider implements SandboxProvider {
    readonly name = "blaxel" as const;

    async startRun(_input: StartRunInput): Promise<SandboxHandle> {
      throw { message: "workspace is required", status: 401 };
    }

    async *exec(_input: ExecInput) {}

    async stop(_handle: SandboxHandle): Promise<void> {}
  }

  const dataDir = await makeTempDir();
  const store = await JsonStore.create(path.join(dataDir, "store.json"));
  const service = createRunService({
    repoRoot: process.cwd(),
    dataDir,
    controlPlaneUrl: "http://127.0.0.1:3000",
    sharedBundleVersion: "v1",
    provider: new ObjectThrowingProvider(),
    store,
  });

  const wake = await service.wake({
    source: "api",
    agentId: "agent-main",
    workspaceId: "workspace-demo",
    message: "This sandbox should fail with a useful object error",
  });
  const completed = await service.waitForRun(wake.runId);

  expect(completed.status).toBe("failed");
  expect(completed.error).toContain("workspace is required");
  expect(completed.error).not.toBe("[object Object]");
});

test("marks the run failed when the runtime emits a failed finish event", async () => {
  const dataDir = await makeTempDir();
  const store = await JsonStore.create(path.join(dataDir, "store.json"));
  const provider = new FailedEventSandboxProvider();
  const service = createRunService({
    repoRoot: process.cwd(),
    dataDir,
    controlPlaneUrl: "http://127.0.0.1:3000",
    sharedBundleVersion: "v1",
    provider,
    store,
  });

  const wake = await service.wake({
    source: "api",
    agentId: "agent-main",
    workspaceId: "workspace-demo",
    message: "This runtime reports failure",
  });
  const completed = await service.waitForRun(wake.runId);

  expect(completed.status).toBe("failed");
  expect(completed.error).toBe("runtime reported failure");
  expect(provider.stopped).toEqual([
    expect.objectContaining({
      sandboxId: `failed-event-${wake.runId}`,
    }),
  ]);
});

test("restores the task status when a run fails after an optimistic task update", async () => {
  const dataDir = await makeTempDir();
  const store = await JsonStore.create(path.join(dataDir, "store.json"));
  const provider = new DoneThenFailingSandboxProvider();
  const service = createRunService({
    repoRoot: process.cwd(),
    dataDir,
    controlPlaneUrl: "http://127.0.0.1:3000",
    sharedBundleVersion: "v1",
    provider,
    store,
  });

  const wake = await service.wake({
    source: "api",
    agentId: "agent-main",
    workspaceId: "workspace-demo",
    message: "This runtime marks done then fails",
  });
  const completed = await service.waitForRun(wake.runId);

  expect(completed.status).toBe("failed");
  expect(store.getTask(completed.taskId!)?.status).toBe("todo");
});
