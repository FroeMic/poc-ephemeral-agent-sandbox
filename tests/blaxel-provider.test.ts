import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, test } from "vitest";
import {
  BlaxelSandboxProvider,
  type BlaxelClientLike,
  type BlaxelSandboxLike,
} from "../packages/sandbox/src/blaxel-provider.js";
import type { RuntimeWakePayload } from "../packages/shared/src/index.js";

const tempDirs: string[] = [];

async function makeTempDir() {
  const dir = await mkdtemp(path.join(os.tmpdir(), "poc-blaxel-provider-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

class FakeSandbox implements BlaxelSandboxLike {
  metadata = { name: "poc-run-1" };
  writes: Array<{ remotePath: string; content: string }> = [];
  writeTrees: Array<{ destinationPath: string; files: Array<{ path: string; content: string | Buffer }> }> = [];
  commandCalls: Array<{ command: string; workingDir?: string; timeout?: number }> = [];
  deleted = false;

  fs = {
    mkdir: async () => undefined,
    write: async (remotePath: string, content: string) => {
      this.writes.push({ remotePath, content });
      return undefined;
    },
    writeBinary: async (remotePath: string, content: Buffer | Uint8Array | string) => {
      this.writes.push({ remotePath, content: Buffer.from(content).toString("utf8") });
      return undefined;
    },
    writeTree: async (files: Array<{ path: string; content: string | Buffer }>, destinationPath?: string | null) => {
      this.writeTrees.push({ destinationPath: destinationPath ?? "", files });
      return undefined;
    },
  };

  process = {
    exec: async (request: { command: string; workingDir?: string; timeout?: number }) => {
      this.commandCalls.push(request);
      return {
        exitCode: 0,
        logs: [
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

class FakeBlaxel implements BlaxelClientLike {
  sandbox = new FakeSandbox();
  volumeCreateCalls: unknown[] = [];
  sandboxCreateCalls: unknown[] = [];

  SandboxInstance = {
    createIfNotExists: async (config: unknown) => {
      this.sandboxCreateCalls.push(config);
      return this.sandbox;
    },
  };

  VolumeInstance = {
    createIfNotExists: async (config: unknown) => {
      this.volumeCreateCalls.push(config);
      return { name: (config as { name: string }).name };
    },
  };
}

function payload(): RuntimeWakePayload {
  const now = "2026-05-18T00:00:00.000Z";
  return {
    run: {
      id: "run-1",
      wakeEventId: "wake-1",
      agentId: "support-agent",
      workspaceId: "support-workspace",
      sandboxProvider: "blaxel",
      sharedBundleVersion: "v1",
      status: "running",
      startedAt: now,
    },
    wakeEvent: {
      id: "wake-1",
      source: "chat",
      agentId: "support-agent",
      workspaceId: "support-workspace",
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

test("creates a Blaxel sandbox with one persistent volume per agent/workspace pair", async () => {
  const fake = new FakeBlaxel();
  const provider = new BlaxelSandboxProvider({
    client: fake,
    apiKey: "fake-key",
    workspace: "fake-workspace",
    image: "blaxel/base-image:latest",
    volumePrefix: "poc-blaxel",
    region: "us-pdx-1",
    memoryMb: 4096,
  });

  const handle = await provider.startRun({
    runId: "run-1",
    agentId: "support-agent",
    workspaceId: "support-workspace",
    agentHomePath: "/tmp/local-agent",
    workspacePath: "/tmp/local-workspace",
    sharedPath: "/tmp/local-shared",
    runPath: "/tmp/local-run",
    wakePath: "/tmp/local-run/wake.json",
  });

  expect(handle.provider).toBe("blaxel");
  expect(handle.sandboxId).toBe("poc-run-1");
  expect(fake.volumeCreateCalls).toEqual([
    expect.objectContaining({ name: "poc-blaxel-state-support-agent-support-workspace", region: "us-pdx-1" }),
  ]);
  expect(fake.sandboxCreateCalls).toEqual([
    expect.objectContaining({
      name: "poc-run-1",
      image: "blaxel/base-image:latest",
      memory: 4096,
      region: "us-pdx-1",
      volumes: [
        { name: "poc-blaxel-state-support-agent-support-workspace", mountPath: "/persistent", readOnly: false },
      ],
    }),
  ]);
});

test("keeps generated Blaxel resource names within the provider limit", async () => {
  const fake = new FakeBlaxel();
  const provider = new BlaxelSandboxProvider({
    client: fake,
    image: "blaxel/base-image:latest",
    volumePrefix: "poc-ephemeral-agent-sandbox",
    region: "us-pdx-1",
  });

  await provider.startRun({
    runId: "run-very-long-id-for-provider-name-test",
    agentId: "bench-blaxel-agent",
    workspaceId: "bench-blaxel-workspace-1779452089756",
    agentHomePath: "/tmp/local-agent",
    workspacePath: "/tmp/local-workspace",
    sharedPath: "/tmp/local-shared",
    runPath: "/tmp/local-run",
    wakePath: "/tmp/local-run/wake.json",
  });

  const volumeNames = fake.volumeCreateCalls.map((call) => (call as { name: string }).name);
  expect(volumeNames).toHaveLength(1);
  expect(volumeNames.every((name) => name.length <= 49)).toBe(true);
  expect(((fake.sandboxCreateCalls[0] as { name: string }).name).length).toBeLessThanOrEqual(49);
});

test("fails fast when the live Blaxel provider is missing BL_WORKSPACE", async () => {
  const provider = new BlaxelSandboxProvider({
    apiKey: "fake-key",
    image: "blaxel/base-image:latest",
    volumePrefix: "poc-blaxel",
  });

  await expect(
    provider.startRun({
      runId: "run-1",
      agentId: "support-agent",
      workspaceId: "support-workspace",
      agentHomePath: "/tmp/local-agent",
      workspacePath: "/tmp/local-workspace",
      sharedPath: "/tmp/local-shared",
      runPath: "/tmp/local-run",
      wakePath: "/tmp/local-run/wake.json",
    }),
  ).rejects.toThrow("BL_WORKSPACE is required");
});

test("uploads the remote runtime and parses Blaxel process JSONL events", async () => {
  const fake = new FakeBlaxel();
  const sharedPath = await makeTempDir();
  await mkdir(path.join(sharedPath, "skills"), { recursive: true });
  await writeFile(path.join(sharedPath, "AGENTS.shared.md"), "# Shared\n", "utf8");
  const provider = new BlaxelSandboxProvider({ client: fake, image: "blaxel/base-image:latest", volumePrefix: "poc-blaxel" });
  const handle = await provider.startRun({
    runId: "run-1",
    agentId: "support-agent",
    workspaceId: "support-workspace",
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
  expect(fake.sandbox.commandCalls[0]?.command).toContain("ln -sfn '/persistent/agent-home' '/agent-home'");
  const runtimeCommand = fake.sandbox.commandCalls.find((call) => call.command.includes("/agentruntime/harness/run.mjs"));
  expect(runtimeCommand).toEqual(
    expect.objectContaining({
      command: expect.stringContaining("node '/agentruntime/harness/run.mjs' '/run/wake.json'"),
      workingDir: "/workspace",
    }),
  );
  expect(events.map((event) => event.type)).toEqual(["runtime_started", "run_finished"]);
});
