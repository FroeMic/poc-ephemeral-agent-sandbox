import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, test } from "vitest";
import { E2BSandboxProvider, type E2BClientLike, type E2BSandboxLike, type E2BVolumeLike } from "../packages/sandbox/src/e2b-provider.js";
import type { RuntimeWakePayload } from "../packages/shared/src/index.js";

const tempDirs: string[] = [];

async function makeTempDir() {
  const dir = await mkdtemp(path.join(os.tmpdir(), "poc-e2b-provider-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

class FakeSandbox implements E2BSandboxLike {
  sandboxId = "e2b-sandbox-123";
  writes: Array<{ remotePath: string; content: string }> = [];
  commandCalls: Array<{ command: string; cwd?: string; envs?: Record<string, string>; timeoutMs?: number }> = [];
  killed = false;
  failCommands = new Map<string, Error>();
  commandResults = new Map<string, { exitCode: number; stdout: string; stderr?: string; error?: string }>();

  files = {
    write: async (remotePath: string, content: string | ArrayBuffer | Blob | ReadableStream) => {
      this.writes.push({
        remotePath,
        content: typeof content === "string" ? content : Buffer.from(content as ArrayBuffer).toString("utf8"),
      });
    },
  };

  commands = {
    run: async (command: string, options?: { cwd?: string; envs?: Record<string, string>; timeoutMs?: number }) => {
      this.commandCalls.push({ command, cwd: options?.cwd, envs: options?.envs, timeoutMs: options?.timeoutMs });
      const failure = [...this.failCommands.entries()].find(([pattern]) => command.includes(pattern))?.[1];
      if (failure) throw failure;
      const result = [...this.commandResults.entries()].find(([pattern]) => command.includes(pattern))?.[1];
      if (result) return result;
      return {
        exitCode: 0,
        stdout: [
          JSON.stringify({ type: "runtime_started", runId: "run-1", timestamp: "2026-05-18T00:00:00.000Z" }),
          JSON.stringify({ type: "run_finished", runId: "run-1", timestamp: "2026-05-18T00:00:00.001Z", status: "succeeded" }),
        ].join("\n"),
        stderr: "",
      };
    },
  };

  async kill() {
    this.killed = true;
  }
}

class FakeE2B implements E2BClientLike {
  sandbox = new FakeSandbox();
  createdVolumes: string[] = [];
  createCalls: unknown[] = [];

  Sandbox = {
    create: async (options: unknown) => {
      this.createCalls.push(options);
      return this.sandbox;
    },
  };

  Volume = {
    create: async (name: string) => {
      this.createdVolumes.push(name);
      return { name, volumeId: `${name}-id` } satisfies E2BVolumeLike;
    },
    list: async () => [],
  };
}

function payload(): RuntimeWakePayload {
  const now = "2026-05-18T00:00:00.000Z";
  return {
    run: {
      id: "run-1",
      wakeEventId: "wake-1",
      agentId: "sales-agent",
      workspaceId: "sales-workspace",
      sandboxProvider: "e2b",
      sharedBundleVersion: "v1",
      status: "running",
      startedAt: now,
    },
    wakeEvent: {
      id: "wake-1",
      source: "chat",
      agentId: "sales-agent",
      workspaceId: "sales-workspace",
      message: "hello",
      createdAt: now,
    },
    agentHomePath: "/agent-home",
    workspacePath: "/workspace",
    sharedPath: "/agentruntime/shared",
    controlPlaneApiUrl: "http://localhost:3777",
    runToken: "/run/wake.json",
  };
}

test("creates an E2B sandbox with one persistent volume per agent and workspace", async () => {
  const fake = new FakeE2B();
  const provider = new E2BSandboxProvider({
    client: fake,
    apiKey: "fake-key",
    template: "poc-node",
    volumePrefix: "poc-e2b",
  });

  const handle = await provider.startRun({
    runId: "run-1",
    agentId: "sales-agent",
    workspaceId: "sales-workspace",
    agentHomePath: "/tmp/local-agent",
    workspacePath: "/tmp/local-workspace",
    sharedPath: "/tmp/local-shared",
    runPath: "/tmp/local-run",
    wakePath: "/tmp/local-run/wake.json",
  });

  expect(handle.provider).toBe("e2b");
  expect(handle.sandboxId).toBe("e2b-sandbox-123");
  expect(fake.createdVolumes).toEqual(["poc-e2b-agent-sales-agent", "poc-e2b-workspace-sales-workspace"]);
  expect(fake.createCalls).toEqual([
    expect.objectContaining({
      apiKey: "fake-key",
      template: "poc-node",
      volumeMounts: {
        "/agent-home": expect.objectContaining({ name: "poc-e2b-agent-sales-agent" }),
        "/workspace": expect.objectContaining({ name: "poc-e2b-workspace-sales-workspace" }),
      },
    }),
  ]);
});

test("includes captured runtime output when an E2B runtime command fails", async () => {
  const fake = new FakeE2B();
  fake.sandbox.commandResults.set("run.mjs", {
    exitCode: 0,
    stdout: "Pi stack trace\n__EXIT_CODE__:1\n",
    stderr: "",
  });
  const sharedPath = await makeTempDir();
  await mkdir(path.join(sharedPath, "skills"), { recursive: true });
  await writeFile(path.join(sharedPath, "AGENTS.shared.md"), "# Shared\n", "utf8");
  const provider = new E2BSandboxProvider({ client: fake, template: "poc-node", volumePrefix: "poc-e2b" });
  const handle = await provider.startRun({
    runId: "run-1",
    agentId: "sales-agent",
    workspaceId: "sales-workspace",
    agentHomePath: "/tmp/local-agent",
    workspacePath: "/tmp/local-workspace",
    sharedPath,
    runPath: "/tmp/local-run",
    wakePath: "/tmp/local-run/wake.json",
  });

  await expect(async () => {
    for await (const _event of provider.exec({ handle, payload: payload() })) {
      // Exhaust iterator.
    }
  }).rejects.toThrow("Pi stack trace");
});

test("can create an E2B sandbox without beta volumes for initial provider smoke tests", async () => {
  const fake = new FakeE2B();
  const provider = new E2BSandboxProvider({
    client: fake,
    apiKey: "fake-key",
    template: "poc-node",
    volumePrefix: "poc-e2b",
    useVolumes: false,
  });

  const handle = await provider.startRun({
    runId: "run-1",
    agentId: "sales-agent",
    workspaceId: "sales-workspace",
    agentHomePath: "/tmp/local-agent",
    workspacePath: "/tmp/local-workspace",
    sharedPath: "/tmp/local-shared",
    runPath: "/tmp/local-run",
    wakePath: "/tmp/local-run/wake.json",
  });

  expect(handle.provider).toBe("e2b");
  expect(fake.createdVolumes).toEqual([]);
  expect(fake.createCalls).toEqual([
    expect.not.objectContaining({
      volumeMounts: expect.anything(),
    }),
  ]);
});

test("mounts Archil storage before preparing the E2B runtime", async () => {
  const fake = new FakeE2B();
  const sharedPath = await makeTempDir();
  await mkdir(path.join(sharedPath, "skills"), { recursive: true });
  await writeFile(path.join(sharedPath, "AGENTS.shared.md"), "# Shared\n", "utf8");
  const provider = new E2BSandboxProvider({
    client: fake,
    template: "poc-archil",
    storageMode: "archil",
    archil: {
      mountToken: "token",
      disk: "org/disk",
      region: "aws-us-east-1",
    },
  });
  const handle = await provider.startRun({
    runId: "run-1",
    agentId: "sales-agent",
    workspaceId: "sales-workspace",
    agentHomePath: "/tmp/local-agent",
    workspacePath: "/tmp/local-workspace",
    sharedPath,
    runPath: "/tmp/local-run",
    wakePath: "/tmp/local-run/wake.json",
  });

  const events = [];
  for await (const event of provider.exec({ handle, payload: payload() })) events.push(event);

  expect(fake.createdVolumes).toEqual([]);
  const archilMount = fake.sandbox.commandCalls.find((call) => call.command.includes("archil mount"));
  expect(archilMount).toEqual(
    expect.objectContaining({
      command: expect.stringContaining("archil mount 'org/disk' '/home/user/archil' --region 'aws-us-east-1'"),
    }),
  );
  expect(fake.sandbox.writes.map((write) => write.remotePath)).toContain("/home/user/agentruntime/harness/run.mjs");
  const wakeUpload = fake.sandbox.writes.find((write) => write.remotePath === "/home/user/run/wake.json");
  expect(wakeUpload?.content).toContain("/home/user/archil/agent-home");
  expect(events.map((event) => event.type)).toEqual(["runtime_started", "run_finished"]);

  await provider.stop(handle);
  expect(fake.sandbox.commandCalls.map((call) => call.command)).toContain("sudo archil unmount '/home/user/archil'");
  expect(fake.sandbox.killed).toBe(true);
});

test("fails fast when E2B Archil config is incomplete", async () => {
  const fake = new FakeE2B();
  const provider = new E2BSandboxProvider({
    client: fake,
    storageMode: "archil",
    archil: {
      mountToken: "token",
    },
  });

  await expect(
    provider.startRun({
      runId: "run-1",
      agentId: "sales-agent",
      workspaceId: "sales-workspace",
      agentHomePath: "/tmp/local-agent",
      workspacePath: "/tmp/local-workspace",
      sharedPath: "/tmp/local-shared",
      runPath: "/tmp/local-run",
      wakePath: "/tmp/local-run/wake.json",
    }),
  ).rejects.toThrow("E2B Archil storage requires");
});

test("adds command context when E2B command execution throws", async () => {
  const fake = new FakeE2B();
  fake.sandbox.failCommands.set("archil mount", new Error("exit status 1"));
  const sharedPath = await makeTempDir();
  await mkdir(path.join(sharedPath, "skills"), { recursive: true });
  await writeFile(path.join(sharedPath, "AGENTS.shared.md"), "# Shared\n", "utf8");
  const provider = new E2BSandboxProvider({
    client: fake,
    storageMode: "archil",
    archil: {
      mountToken: "token",
      disk: "org/disk",
      region: "aws-us-east-1",
    },
  });
  const handle = await provider.startRun({
    runId: "run-1",
    agentId: "sales-agent",
    workspaceId: "sales-workspace",
    agentHomePath: "/tmp/local-agent",
    workspacePath: "/tmp/local-workspace",
    sharedPath,
    runPath: "/tmp/local-run",
    wakePath: "/tmp/local-run/wake.json",
  });

  await expect(async () => {
    for await (const _event of provider.exec({ handle, payload: payload() })) {
      // Exhaust iterator.
    }
  }).rejects.toThrow("E2B command failed while mounting Archil disk");
});

test("uploads the remote runtime and parses E2B command JSONL events", async () => {
  const fake = new FakeE2B();
  const sharedPath = await makeTempDir();
  await mkdir(path.join(sharedPath, "skills"), { recursive: true });
  await writeFile(path.join(sharedPath, "AGENTS.shared.md"), "# Shared\n", "utf8");
  const provider = new E2BSandboxProvider({ client: fake, template: "poc-node", volumePrefix: "poc-e2b" });
  const handle = await provider.startRun({
    runId: "run-1",
    agentId: "sales-agent",
    workspaceId: "sales-workspace",
    agentHomePath: "/tmp/local-agent",
    workspacePath: "/tmp/local-workspace",
    sharedPath,
    runPath: "/tmp/local-run",
    wakePath: "/tmp/local-run/wake.json",
  });

  const events = [];
  for await (const event of provider.exec({ handle, payload: payload() })) events.push(event);

  expect(fake.sandbox.writes.map((write) => write.remotePath)).toContain("/agentruntime/harness/run.mjs");
  expect(fake.sandbox.writes.map((write) => write.remotePath)).toContain("/run/wake.json");
  const runtimeCommand = fake.sandbox.commandCalls.find((call) => call.command.includes("/agentruntime/harness/run.mjs"));
  expect(runtimeCommand).toEqual(
    expect.objectContaining({
      command: expect.stringContaining("node '/agentruntime/harness/run.mjs' '/run/wake.json'"),
      cwd: "/workspace",
    }),
  );
  expect(events.map((event) => event.type)).toEqual(["runtime_started", "run_finished"]);
});
