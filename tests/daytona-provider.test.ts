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

class FakeDaytona implements DaytonaClientLike {
  sandbox = new FakeSandbox();
  volumeGetCalls: Array<{ name: string; create: boolean }> = [];
  createParams: unknown[] = [];

  volume = {
    get: async (name: string, create: boolean) => {
      this.volumeGetCalls.push({ name, create });
      return { id: "volume-123", name };
    },
  };

  async create(params: unknown) {
    this.createParams.push(params);
    return this.sandbox;
  }
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
