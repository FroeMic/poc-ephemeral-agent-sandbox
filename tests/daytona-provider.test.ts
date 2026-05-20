import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, test } from "vitest";
import { DaytonaSandboxProvider, type DaytonaClientLike, type DaytonaSandboxLike } from "../packages/sandbox/src/daytona-provider.js";
import type { RuntimeWakePayload } from "../packages/shared/src/index.js";

const tempDirs: string[] = [];

async function makeTempDir() {
  const dir = await mkdtemp(path.join(os.tmpdir(), "poc-daytona-provider-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

class FakeSandbox implements DaytonaSandboxLike {
  id = "sandbox-123";
  uploads: Array<{ remotePath: string; content: string }> = [];
  commands: Array<{ command: string; cwd?: string; env?: Record<string, string> }> = [];
  deleted = false;
  failNpmInstall = false;

  fs = {
    uploadFile: async (content: Buffer | string, remotePath: string) => {
      this.uploads.push({
        remotePath,
        content: Buffer.isBuffer(content) ? content.toString("utf8") : content,
      });
    },
  };

  process = {
    executeCommand: async (command: string, cwd?: string, env?: Record<string, string>) => {
      this.commands.push({ command, cwd, env });
      if (this.failNpmInstall && command === "npm install --omit=dev") {
        return {
          exitCode: 1,
          result: "npm install failed",
        };
      }
      return {
        exitCode: 0,
        result: [
          JSON.stringify({ type: "runtime_started", runId: "run-1", timestamp: "2026-05-18T00:00:00.000Z" }),
          JSON.stringify({ type: "run_finished", runId: "run-1", timestamp: "2026-05-18T00:00:00.001Z", status: "succeeded" }),
        ].join("\n"),
      };
    },
  };

  async delete() {
    this.deleted = true;
  }
}

class StreamingFakeSandbox extends FakeSandbox {
  sessionCreateCalls: string[] = [];
  sessionDeleteCalls: string[] = [];
  sessionExecCalls: Array<{ sessionId: string; req: { command: string; runAsync?: boolean; suppressInputEcho?: boolean } }> = [];
  sessionLogCalls: Array<{ sessionId: string; commandId: string }> = [];
  sessionExitCode: number | undefined = 0;

  override process = {
    ...this.process,
    createSession: async (sessionId: string) => {
      this.sessionCreateCalls.push(sessionId);
    },
    executeSessionCommand: async (
      sessionId: string,
      req: { command: string; runAsync?: boolean; suppressInputEcho?: boolean },
    ) => {
      this.sessionExecCalls.push({ sessionId, req });
      return { cmdId: "cmd-1" };
    },
    getSessionCommandLogs: async (
      sessionId: string,
      commandId: string,
      onStdout: (chunk: string) => void,
      onStderr: (chunk: string) => void,
    ) => {
      this.sessionLogCalls.push({ sessionId, commandId });
      onStdout(`${JSON.stringify({ type: "runtime_started", runId: "run-1", timestamp: "2026-05-18T00:00:00.000Z" })}\n`);
      onStdout(JSON.stringify({ type: "run_finished", runId: "run-1", timestamp: "2026-05-18T00:00:00.001Z", status: "succeeded" }).slice(0, 40));
      onStdout(`${JSON.stringify({ type: "run_finished", runId: "run-1", timestamp: "2026-05-18T00:00:00.001Z", status: "succeeded" }).slice(40)}\n`);
      onStderr("diagnostic warning\n");
    },
    getSessionCommand: async () => ({ exitCode: this.sessionExitCode }),
    deleteSession: async (sessionId: string) => {
      this.sessionDeleteCalls.push(sessionId);
    },
  };
}

class FakeDaytona implements DaytonaClientLike {
  sandbox = new FakeSandbox();
  volumeGetCalls: Array<{ name: string; create: boolean }> = [];
  createParams: unknown[] = [];
  createFailures: Error[] = [];

  volume = {
    get: async (name: string, create: boolean) => {
      this.volumeGetCalls.push({ name, create });
      return { id: "volume-123", name };
    },
  };

  async create(params: unknown) {
    this.createParams.push(params);
    const failure = this.createFailures.shift();
    if (failure) throw failure;
    return this.sandbox;
  }
}

class StreamingFakeDaytona extends FakeDaytona {
  override sandbox = new StreamingFakeSandbox();
}

function payload(): RuntimeWakePayload {
  const now = "2026-05-18T00:00:00.000Z";
  return {
    run: {
      id: "run-1",
      wakeEventId: "wake-1",
      agentId: "agent-main",
      workspaceId: "workspace-demo",
      taskId: "task-1",
      sandboxProvider: "daytona",
      sharedBundleVersion: "v1",
      status: "running",
      startedAt: now,
    },
    wakeEvent: {
      id: "wake-1",
      source: "api",
      agentId: "agent-main",
      workspaceId: "workspace-demo",
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

test("creates a Daytona sandbox with persistent agent and workspace volume subpaths", async () => {
  const fake = new FakeDaytona();
  const provider = new DaytonaSandboxProvider({
    client: fake,
    volumeName: "poc-volume",
    image: "node:22-bookworm",
  });

  const handle = await provider.startRun({
    runId: "run-1",
    agentId: "agent-main",
    workspaceId: "workspace-demo",
    agentHomePath: "/tmp/local-agent",
    workspacePath: "/tmp/local-workspace",
    sharedPath: "/tmp/local-shared",
    runPath: "/tmp/local-run",
    wakePath: "/tmp/local-run/wake.json",
  });

  expect(handle.provider).toBe("daytona");
  expect(handle.sandboxId).toBe("sandbox-123");
  expect(handle.runtimePaths).toEqual({
    agentHomePath: "/agent-home",
    workspacePath: "/workspace",
    sharedPath: "/agentruntime/shared",
    runPath: "/run",
    wakePath: "/run/wake.json",
  });
  expect(fake.volumeGetCalls).toEqual([{ name: "poc-volume", create: true }]);
  expect(fake.createParams).toEqual([
    expect.objectContaining({
      image: "node:22-bookworm",
      ephemeral: true,
      volumes: [
        { volumeId: "volume-123", mountPath: "/agent-home", subpath: "agents/agent-main" },
        { volumeId: "volume-123", mountPath: "/workspace", subpath: "workspaces/workspace-demo" },
      ],
    }),
  ]);
});

test("retries sandbox creation while Daytona volume is pending creation", async () => {
  const fake = new FakeDaytona();
  fake.createFailures.push(
    new Error("Volume 'poc-volume' is not in a ready state. Current state: pending_create"),
  );
  const provider = new DaytonaSandboxProvider({
    client: fake,
    volumeName: "poc-volume",
    image: "node:22-bookworm",
    volumeReadyPollMs: 1,
  });

  const handle = await provider.startRun({
    runId: "run-1",
    agentId: "agent-main",
    workspaceId: "workspace-demo",
    agentHomePath: "/tmp/local-agent",
    workspacePath: "/tmp/local-workspace",
    sharedPath: "/tmp/local-shared",
    runPath: "/tmp/local-run",
    wakePath: "/tmp/local-run/wake.json",
  });

  expect(handle.sandboxId).toBe("sandbox-123");
  expect(fake.createParams).toHaveLength(2);
});

test("rejects unsafe agent and workspace ids before creating Daytona volume subpaths", async () => {
  const fake = new FakeDaytona();
  const provider = new DaytonaSandboxProvider({
    client: fake,
    volumeName: "poc-volume",
  });

  await expect(
    provider.startRun({
      runId: "run-1",
      agentId: "../agent-main",
      workspaceId: "workspace-demo",
      agentHomePath: "/tmp/local-agent",
      workspacePath: "/tmp/local-workspace",
      sharedPath: "/tmp/local-shared",
      runPath: "/tmp/local-run",
      wakePath: "/tmp/local-run/wake.json",
    }),
  ).rejects.toThrow("Invalid Daytona agentId");

  await expect(
    provider.startRun({
      runId: "run-1",
      agentId: "agent-main",
      workspaceId: "tenant/workspace-demo",
      agentHomePath: "/tmp/local-agent",
      workspacePath: "/tmp/local-workspace",
      sharedPath: "/tmp/local-shared",
      runPath: "/tmp/local-run",
      wakePath: "/tmp/local-run/wake.json",
    }),
  ).rejects.toThrow("Invalid Daytona workspaceId");

  expect(fake.createParams).toEqual([]);
});

test("uploads runtime files and parses JSONL events from Daytona command output", async () => {
  const root = await makeTempDir();
  const sharedPath = path.join(root, "shared");
  await mkdir(path.join(sharedPath, "skills"), { recursive: true });
  await writeFile(path.join(sharedPath, "manifest.json"), '{"version":"v1"}\n', "utf8");
  await writeFile(path.join(sharedPath, "skills", "SKILL.md"), "skill\n", "utf8");

  const fake = new FakeDaytona();
  const provider = new DaytonaSandboxProvider({
    client: fake,
    volumeName: "poc-volume",
  });
  const handle = await provider.startRun({
    runId: "run-1",
    agentId: "agent-main",
    workspaceId: "workspace-demo",
    agentHomePath: path.join(root, "agent-home"),
    workspacePath: path.join(root, "workspace"),
    sharedPath,
    runPath: path.join(root, "run"),
    wakePath: path.join(root, "run", "wake.json"),
  });

  const events = [];
  for await (const event of provider.exec({ handle, payload: payload() })) {
    events.push(event);
  }

  expect(fake.sandbox.uploads.map((upload) => upload.remotePath)).toEqual(
    expect.arrayContaining([
      "/agentruntime/harness/run.mjs",
      "/agentruntime/shared/manifest.json",
      "/agentruntime/shared/skills/SKILL.md",
      "/run/wake.json",
    ]),
  );
  expect(fake.sandbox.commands.map((entry) => entry.command).join("\n")).toContain(
    "node '/agentruntime/harness/run.mjs' '/run/wake.json'",
  );
  expect(events.map((event) => event.type)).toEqual(["runtime_started", "run_finished"]);
});

test("removes the ephemeral runtime env file before deleting the Daytona sandbox", async () => {
  const fake = new FakeDaytona();
  const provider = new DaytonaSandboxProvider({
    client: fake,
    volumeName: "poc-volume",
  });
  const handle = await provider.startRun({
    runId: "run-1",
    agentId: "agent-main",
    workspaceId: "workspace-demo",
    agentHomePath: "/tmp/local-agent",
    workspacePath: "/tmp/local-workspace",
    sharedPath: "/tmp/local-shared",
    runPath: "/tmp/local-run",
    wakePath: "/tmp/local-run/wake.json",
  });

  await provider.stop(handle);

  expect(fake.sandbox.commands.map((entry) => entry.command)).toContain("rm -f '/run/runtime-env.sh'");
  expect(fake.sandbox.deleted).toBe(true);
});

test("streams JSONL events from Daytona followed session logs when available", async () => {
  const root = await makeTempDir();
  const sharedPath = path.join(root, "shared");
  await mkdir(path.join(sharedPath, "skills"), { recursive: true });
  await writeFile(path.join(sharedPath, "manifest.json"), '{"version":"v1"}\n', "utf8");

  const fake = new StreamingFakeDaytona();
  const provider = new DaytonaSandboxProvider({
    client: fake,
    volumeName: "poc-volume",
  });
  const handle = await provider.startRun({
    runId: "run-1",
    agentId: "agent-main",
    workspaceId: "workspace-demo",
    agentHomePath: path.join(root, "agent-home"),
    workspacePath: path.join(root, "workspace"),
    sharedPath,
    runPath: path.join(root, "run"),
    wakePath: path.join(root, "run", "wake.json"),
  });

  const events = [];
  for await (const event of provider.exec({ handle, payload: payload() })) {
    events.push(event);
  }

  expect(fake.sandbox.sessionCreateCalls).toEqual(["run-run-1"]);
  expect(fake.sandbox.sessionExecCalls[0]?.sessionId).toBe("run-run-1");
  expect(fake.sandbox.sessionExecCalls[0]?.req).toEqual(
    expect.objectContaining({
      runAsync: true,
      suppressInputEcho: true,
    }),
  );
  expect(fake.sandbox.sessionExecCalls[0]?.req.command).toContain("cd '/workspace' &&");
  expect(fake.sandbox.sessionExecCalls[0]?.req.command).toContain(". '/run/runtime-env.sh'");
  expect(fake.sandbox.sessionExecCalls[0]?.req.command).toContain("node '/agentruntime/harness/run.mjs' '/run/wake.json'");
  const envUpload = fake.sandbox.uploads.find((upload) => upload.remotePath === "/run/runtime-env.sh");
  expect(envUpload?.content).toContain("PI_CODING_AGENT_DIR='/agent-home/pi'");
  expect(fake.sandbox.sessionLogCalls).toEqual([{ sessionId: "run-run-1", commandId: "cmd-1" }]);
  expect(fake.sandbox.sessionDeleteCalls).toEqual(["run-run-1"]);
  expect(events.map((event) => event.type)).toEqual(["runtime_started", "run_finished", "stderr"]);
});

test("keeps provider API keys out of the streamed Daytona command string", async () => {
  const root = await makeTempDir();
  const sharedPath = path.join(root, "shared");
  await mkdir(sharedPath, { recursive: true });
  await writeFile(path.join(sharedPath, "manifest.json"), '{"version":"v1"}\n', "utf8");

  const previousOpenAiKey = process.env.OPENAI_API_KEY;
  process.env.OPENAI_API_KEY = "secret-openai-key";
  try {
    const fake = new StreamingFakeDaytona();
    const provider = new DaytonaSandboxProvider({
      client: fake,
      volumeName: "poc-volume",
    });
    const handle = await provider.startRun({
      runId: "run-1",
      agentId: "agent-main",
      workspaceId: "workspace-demo",
      agentHomePath: path.join(root, "agent-home"),
      workspacePath: path.join(root, "workspace"),
      sharedPath,
      runPath: path.join(root, "run"),
      wakePath: path.join(root, "run", "wake.json"),
    });

    for await (const _event of provider.exec({ handle, payload: payload() })) {
      // Drain streamed output.
    }

    const command = fake.sandbox.sessionExecCalls[0]?.req.command ?? "";
    expect(command).toContain(". '/run/runtime-env.sh'");
    expect(command).not.toContain("secret-openai-key");
    const envUpload = fake.sandbox.uploads.find((upload) => upload.remotePath === "/run/runtime-env.sh");
    expect(envUpload?.content).toContain("OPENAI_API_KEY='secret-openai-key'");
    expect(fake.sandbox.commands.map((entry) => entry.command)).toContain("chmod 600 '/run/runtime-env.sh'");
  } finally {
    if (previousOpenAiKey === undefined) {
      delete process.env.OPENAI_API_KEY;
    } else {
      process.env.OPENAI_API_KEY = previousOpenAiKey;
    }
  }
});

test("treats a streamed Daytona command without an exit code as failed", async () => {
  const root = await makeTempDir();
  const sharedPath = path.join(root, "shared");
  await mkdir(sharedPath, { recursive: true });
  await writeFile(path.join(sharedPath, "manifest.json"), '{"version":"v1"}\n', "utf8");

  const fake = new StreamingFakeDaytona();
  fake.sandbox.sessionExitCode = undefined;
  const provider = new DaytonaSandboxProvider({
    client: fake,
    volumeName: "poc-volume",
  });
  const handle = await provider.startRun({
    runId: "run-1",
    agentId: "agent-main",
    workspaceId: "workspace-demo",
    agentHomePath: path.join(root, "agent-home"),
    workspacePath: path.join(root, "workspace"),
    sharedPath,
    runPath: path.join(root, "run"),
    wakePath: path.join(root, "run", "wake.json"),
  });

  await expect(async () => {
    for await (const _event of provider.exec({ handle, payload: payload() })) {
      // Drain streamed output.
    }
  }).rejects.toThrow("Daytona runtime command finished without an exit code");

  expect(fake.sandbox.sessionDeleteCalls).toEqual(["run-run-1"]);
});

test("uploads the Pi runtime bundle when agent runtime mode is pi", async () => {
  const root = await makeTempDir();
  const sharedPath = path.join(root, "shared");
  await mkdir(sharedPath, { recursive: true });
  await writeFile(path.join(sharedPath, "manifest.json"), '{"version":"v1"}\n', "utf8");

  const fake = new FakeDaytona();
  const provider = new DaytonaSandboxProvider({
    client: fake,
    volumeName: "poc-volume",
    agentRuntime: {
      mode: "pi",
      pi: {
        model: "openai/gpt-5.5",
        thinkingLevel: "high",
      },
    },
  });
  const handle = await provider.startRun({
    runId: "run-1",
    agentId: "agent-main",
    workspaceId: "workspace-demo",
    agentHomePath: path.join(root, "agent-home"),
    workspacePath: path.join(root, "workspace"),
    sharedPath,
    runPath: path.join(root, "run"),
    wakePath: path.join(root, "run", "wake.json"),
  });

  for await (const _event of provider.exec({ handle, payload: payload() })) {
    // Drain the fake command output so uploads are performed.
  }

  const runner = fake.sandbox.uploads.find((upload) => upload.remotePath === "/agentruntime/harness/run.mjs");
  expect(runner?.content).toContain("@earendil-works/pi-coding-agent");
  expect(runner?.content).toContain("/agent-home/pi");
  expect(runner?.content).toContain("async function copyTree");
  expect(runner?.content).toContain("await writeFile(destinationPath, await readFile(sourcePath))");
  expect(runner?.content).not.toContain(" cp(");
  expect(runner?.content).toContain("openai/gpt-5.5");
  expect(runner?.content).toContain("high");
  expect(runner?.content).toContain('source: "rpc"');
  expect(runner?.content).not.toContain('source: "api"');
});

test("prepares Pi dependencies and passes provider API keys to the Daytona command", async () => {
  const root = await makeTempDir();
  const sharedPath = path.join(root, "shared");
  await mkdir(sharedPath, { recursive: true });
  await writeFile(path.join(sharedPath, "manifest.json"), '{"version":"v1"}\n', "utf8");

  const previousOpenAiKey = process.env.OPENAI_API_KEY;
  process.env.OPENAI_API_KEY = "test-openai-key";
  try {
    const fake = new FakeDaytona();
    const provider = new DaytonaSandboxProvider({
      client: fake,
      volumeName: "poc-volume",
      agentRuntime: {
        mode: "pi",
        pi: {
          model: "openai/gpt-5.5",
          thinkingLevel: "high",
        },
      },
    });
    const handle = await provider.startRun({
      runId: "run-1",
      agentId: "agent-main",
      workspaceId: "workspace-demo",
      agentHomePath: path.join(root, "agent-home"),
      workspacePath: path.join(root, "workspace"),
      sharedPath,
      runPath: path.join(root, "run"),
      wakePath: path.join(root, "run", "wake.json"),
    });

    for await (const _event of provider.exec({ handle, payload: payload() })) {
      // Drain fake output.
    }

    expect(fake.sandbox.uploads.map((upload) => upload.remotePath)).toContain("/agentruntime/harness/package.json");
    expect(fake.sandbox.commands.map((entry) => entry.command).join("\n")).toContain("npm install");
    const runCommand = fake.sandbox.commands.find((entry) =>
      entry.command.includes("node '/agentruntime/harness/run.mjs' '/run/wake.json'"),
    );
    expect(runCommand?.env?.OPENAI_API_KEY).toBe("test-openai-key");
    expect(runCommand?.env?.PI_CODING_AGENT_DIR).toBe("/agent-home/pi");
  } finally {
    if (previousOpenAiKey === undefined) {
      delete process.env.OPENAI_API_KEY;
    } else {
      process.env.OPENAI_API_KEY = previousOpenAiKey;
    }
  }
});

test("fails before running the Pi harness when dependency installation fails", async () => {
  const root = await makeTempDir();
  const sharedPath = path.join(root, "shared");
  await mkdir(sharedPath, { recursive: true });
  await writeFile(path.join(sharedPath, "manifest.json"), '{"version":"v1"}\n', "utf8");

  const fake = new FakeDaytona();
  fake.sandbox.failNpmInstall = true;
  const provider = new DaytonaSandboxProvider({
    client: fake,
    volumeName: "poc-volume",
    agentRuntime: {
      mode: "pi",
      pi: {
        model: "openai/gpt-5.5",
        thinkingLevel: "high",
      },
    },
  });
  const handle = await provider.startRun({
    runId: "run-1",
    agentId: "agent-main",
    workspaceId: "workspace-demo",
    agentHomePath: path.join(root, "agent-home"),
    workspacePath: path.join(root, "workspace"),
    sharedPath,
    runPath: path.join(root, "run"),
    wakePath: path.join(root, "run", "wake.json"),
  });

  await expect(async () => {
    for await (const _event of provider.exec({ handle, payload: payload() })) {
      // Drain if anything is yielded.
    }
  }).rejects.toThrow("Pi dependency install failed");

  expect(fake.sandbox.commands.map((entry) => entry.command)).not.toContain(
    "node '/agentruntime/harness/run.mjs' '/run/wake.json'",
  );
});
