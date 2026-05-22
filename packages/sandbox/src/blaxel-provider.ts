import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";
import { SandboxInstance, VolumeInstance } from "@blaxel/core";
import { idSegmentSchema, type RunEvent, type RuntimeWakePayload } from "@poc/shared";
import type { AgentRuntimeConfig, ExecInput, SandboxHandle, SandboxProvider, StartRunInput } from "./types.js";
import {
  listFilesRecursive,
  parseJsonlEvents,
  remotePiPackageJson,
  remotePiRuntimeSource,
  remoteRuntimeSource,
  REMOTE_AGENT_HOME,
  REMOTE_HARNESS,
  REMOTE_RUN,
  REMOTE_SHARED,
  REMOTE_WAKE,
  REMOTE_WORKSPACE,
  runtimeCommandEnv,
  runtimeCommandEnvSource,
  shellQuote,
  withRemoteRuntimePaths,
} from "./daytona-provider.js";

export type BlaxelSandboxLike = {
  metadata: { name: string };
  fs: {
    mkdir(path: string, permissions?: string): Promise<unknown>;
    write(remotePath: string, content: string): Promise<unknown>;
    writeBinary(remotePath: string, content: Buffer | Blob | File | Uint8Array | string): Promise<unknown>;
    writeTree(files: Array<{ path: string; content: string | Buffer }>, destinationPath?: string | null): Promise<unknown>;
  };
  process: {
    exec(request: {
      command: string;
      workingDir?: string;
      env?: Record<string, string>;
      timeout?: number;
      waitForCompletion?: boolean;
    }): Promise<{ exitCode: number; stdout?: string; stderr?: string; logs?: string }>;
  };
  delete(): Promise<unknown>;
};

export type BlaxelClientLike = {
  SandboxInstance: {
    createIfNotExists(config: unknown): Promise<BlaxelSandboxLike>;
  };
  VolumeInstance: {
    createIfNotExists(config: unknown): Promise<{ name: string }>;
  };
};

export type BlaxelSandboxProviderOptions = {
  client?: BlaxelClientLike;
  apiKey?: string | undefined;
  workspace?: string | undefined;
  image?: string | undefined;
  volumePrefix?: string | undefined;
  region?: string | undefined;
  memoryMb?: number | undefined;
  createTimeoutSec?: number;
  commandTimeoutSec?: number;
  deleteTimeoutSec?: number;
  agentRuntime?: AgentRuntimeConfig;
};

type BlaxelHandle = SandboxHandle & {
  sandbox: BlaxelSandboxLike;
  localSharedPath: string;
};

const DEFAULT_IMAGE = "blaxel/base-image:latest";
const DEFAULT_VOLUME_PREFIX = "poc-blaxel";
const DEFAULT_MEMORY_MB = 4096;
const BLAXEL_NAME_LIMIT = 49;
const REMOTE_PERSISTENT = "/persistent";
const DEFAULT_AGENT_RUNTIME: AgentRuntimeConfig = {
  mode: "mock",
  pi: {
    model: "openai/gpt-5.5",
    thinkingLevel: "medium",
  },
};

function createBlaxelClient(): BlaxelClientLike {
  return { SandboxInstance, VolumeInstance } as unknown as BlaxelClientLike;
}

function assertSafeId(kind: "agentId" | "workspaceId", value: string) {
  const parsed = idSegmentSchema.safeParse(value);
  if (!parsed.success) throw new Error(`Invalid Blaxel ${kind}: must be a safe path segment`);
}

function resourceName(prefix: string, kind: "agent" | "workspace" | "state", id: string) {
  const cleaned = `${prefix}-${kind}-${id}`.replace(/[^A-Za-z0-9-]/g, "-").replace(/-+/g, "-");
  if (cleaned.length <= BLAXEL_NAME_LIMIT) return cleaned;
  const suffix = createHash("sha1").update(cleaned).digest("hex").slice(0, 8);
  return `${cleaned.slice(0, BLAXEL_NAME_LIMIT - suffix.length - 1).replace(/-+$/g, "")}-${suffix}`;
}

export class BlaxelSandboxProvider implements SandboxProvider {
  readonly name = "blaxel" as const;
  private readonly client: BlaxelClientLike;
  private readonly apiKey: string | undefined;
  private readonly workspace: string | undefined;
  private readonly image: string;
  private readonly volumePrefix: string;
  private readonly region: string | undefined;
  private readonly memoryMb: number;
  private readonly createTimeoutSec: number;
  private readonly commandTimeoutSec: number;
  private readonly deleteTimeoutSec: number;
  private readonly agentRuntime: AgentRuntimeConfig;
  private readonly usesInjectedClient: boolean;

  constructor(options: BlaxelSandboxProviderOptions = {}) {
    this.usesInjectedClient = options.client !== undefined;
    this.client = options.client ?? createBlaxelClient();
    this.apiKey = options.apiKey;
    this.workspace = options.workspace;
    this.image = options.image ?? DEFAULT_IMAGE;
    this.volumePrefix = options.volumePrefix ?? DEFAULT_VOLUME_PREFIX;
    this.region = options.region;
    this.memoryMb = options.memoryMb ?? DEFAULT_MEMORY_MB;
    this.createTimeoutSec = options.createTimeoutSec ?? 120;
    this.commandTimeoutSec = options.commandTimeoutSec ?? 900;
    this.deleteTimeoutSec = options.deleteTimeoutSec ?? 60;
    this.agentRuntime = options.agentRuntime ?? DEFAULT_AGENT_RUNTIME;
    if (this.apiKey) process.env.BL_API_KEY = this.apiKey;
    if (this.workspace) process.env.BL_WORKSPACE = this.workspace;
  }

  getAgentRuntimeConfig(): AgentRuntimeConfig {
    return this.agentRuntime;
  }

  getEnvironmentConfig(): { BL_API_KEY?: string; BL_WORKSPACE?: string } {
    return {
      ...(this.apiKey ? { BL_API_KEY: this.apiKey } : {}),
      ...(this.workspace ? { BL_WORKSPACE: this.workspace } : {}),
    };
  }

  async startRun(input: StartRunInput): Promise<BlaxelHandle> {
    assertSafeId("agentId", input.agentId);
    assertSafeId("workspaceId", input.workspaceId);
    if (!this.usesInjectedClient && !this.workspace) {
      throw new Error("BL_WORKSPACE is required for the live Blaxel provider. Add BL_WORKSPACE=<your-workspace> to .env.");
    }

    const stateVolumeName = resourceName(this.volumePrefix, "state", `${input.agentId}-${input.workspaceId}`);
    await this.client.VolumeInstance.createIfNotExists({
      name: stateVolumeName,
      ...(this.region ? { region: this.region } : {}),
    });

    const sandboxName = `poc-${input.runId}`.replace(/[^A-Za-z0-9-]/g, "-").slice(0, 63);
    const sandbox = await this.client.SandboxInstance.createIfNotExists({
      name: sandboxName,
      image: this.image,
      memory: this.memoryMb,
      ...(this.region ? { region: this.region } : {}),
      labels: {
        app: "poc-ephemeral-agent-sandbox",
        runId: input.runId,
      },
      volumes: [
        { name: stateVolumeName, mountPath: REMOTE_PERSISTENT, readOnly: false },
      ],
    });

    return {
      provider: this.name,
      sandboxId: sandbox.metadata.name,
      sandbox,
      localSharedPath: input.sharedPath,
      runtimePaths: {
        agentHomePath: REMOTE_AGENT_HOME,
        workspacePath: REMOTE_WORKSPACE,
        sharedPath: REMOTE_SHARED,
        runPath: REMOTE_RUN,
        wakePath: REMOTE_WAKE,
      },
    };
  }

  async *exec(input: ExecInput): AsyncIterable<RunEvent> {
    const handle = input.handle as BlaxelHandle;
    if (!handle.sandbox) throw new Error("Blaxel handle is missing sandbox instance");

    await this.prepareRemoteRuntime(handle.sandbox, input.payload, handle.localSharedPath);
    if (this.agentRuntime.mode === "pi" && this.agentRuntime.pi.installDeps !== false) {
      const installResult = await handle.sandbox.process.exec({
        command: "npm install --omit=dev",
        workingDir: REMOTE_HARNESS,
        env: runtimeCommandEnv(),
        timeout: this.commandTimeoutSec,
        waitForCompletion: true,
      });
      if (installResult.exitCode !== 0) {
        throw new Error(`Pi dependency install failed with code ${installResult.exitCode}: ${installResult.stderr ?? installResult.logs ?? ""}`);
      }
    }

    const command = `node ${shellQuote(path.posix.join(REMOTE_HARNESS, "run.mjs"))} ${shellQuote(REMOTE_WAKE)}`;
    const result = await handle.sandbox.process.exec({
      command,
      workingDir: REMOTE_WORKSPACE,
      env: runtimeCommandEnv(),
      timeout: this.commandTimeoutSec,
      waitForCompletion: true,
    });

    for (const event of parseJsonlEvents(result.stdout ?? result.logs ?? "", input.payload.run.id)) {
      yield event;
    }
    if (result.exitCode !== 0) {
      throw new Error(`Blaxel runtime exited with code ${result.exitCode}: ${result.stderr ?? result.logs ?? ""}`);
    }
  }

  async stop(handle: SandboxHandle): Promise<void> {
    const blaxelHandle = handle as BlaxelHandle;
    if (blaxelHandle.sandbox) {
      await blaxelHandle.sandbox.delete();
    }
  }

  private async prepareRemoteRuntime(sandbox: BlaxelSandboxLike, payload: RuntimeWakePayload, localSharedPath: string) {
    await sandbox.process.exec({
      command: [
        `mkdir -p ${shellQuote(path.posix.join(REMOTE_PERSISTENT, "agent-home"))} ${shellQuote(path.posix.join(REMOTE_PERSISTENT, "workspace"))}`,
        `rm -rf ${shellQuote(REMOTE_AGENT_HOME)} ${shellQuote(REMOTE_WORKSPACE)}`,
        `ln -sfn ${shellQuote(path.posix.join(REMOTE_PERSISTENT, "agent-home"))} ${shellQuote(REMOTE_AGENT_HOME)}`,
        `ln -sfn ${shellQuote(path.posix.join(REMOTE_PERSISTENT, "workspace"))} ${shellQuote(REMOTE_WORKSPACE)}`,
      ].join(" && "),
      timeout: this.commandTimeoutSec,
      waitForCompletion: true,
    });

    await Promise.all([
      sandbox.fs.mkdir(REMOTE_HARNESS),
      sandbox.fs.mkdir(REMOTE_SHARED),
      sandbox.fs.mkdir(REMOTE_RUN),
      sandbox.fs.mkdir(path.posix.join(REMOTE_AGENT_HOME, "sessions")),
      sandbox.fs.mkdir(path.posix.join(REMOTE_WORKSPACE, "notes")),
      sandbox.fs.mkdir(path.posix.join(REMOTE_WORKSPACE, "artifacts")),
      sandbox.fs.mkdir(path.posix.join(REMOTE_WORKSPACE, "crm")),
    ]);

    const runtimeSource =
      this.agentRuntime.mode === "pi" ? remotePiRuntimeSource(this.agentRuntime) : remoteRuntimeSource();
    await sandbox.fs.write(path.posix.join(REMOTE_HARNESS, "run.mjs"), runtimeSource);
    if (this.agentRuntime.mode === "pi") {
      await sandbox.fs.write(path.posix.join(REMOTE_HARNESS, "package.json"), remotePiPackageJson());
    }
    await sandbox.fs.write(REMOTE_WAKE, JSON.stringify(withRemoteRuntimePaths(payload), null, 2));
    await sandbox.fs.write(REMOTE_RUN + "/runtime-env.sh", runtimeCommandEnvSource());
    await this.uploadSharedBundle(sandbox, localSharedPath);
    await this.ensurePersistentFile(sandbox, path.posix.join(REMOTE_AGENT_HOME, "IDENTITY.md"), "# Agent Identity\n\nYou are the default PoC workspace agent.\n");
    await this.ensurePersistentFile(sandbox, path.posix.join(REMOTE_AGENT_HOME, "MEMORY.md"), "# Agent Memory\n\n");
    await this.ensurePersistentFile(sandbox, path.posix.join(REMOTE_AGENT_HOME, "state.json"), '{\n  "version": 1\n}\n');
    await this.ensurePersistentFile(sandbox, path.posix.join(REMOTE_WORKSPACE, "AGENTS.md"), "# Workspace Instructions\n\nThis workspace represents one business or project operated by the agent.\n");
    await this.ensurePersistentFile(sandbox, path.posix.join(REMOTE_WORKSPACE, "TASKS.md"), "# Tasks\n\nCanonical tasks live in the control plane. This file is a local mirror for PoC visibility.\n");
  }

  private async uploadSharedBundle(sandbox: BlaxelSandboxLike, sharedPath: string) {
    for (const file of await listFilesRecursive(sharedPath)) {
      const remotePath = path.posix.join(REMOTE_SHARED, file.relativePath);
      await sandbox.fs.writeBinary(remotePath, await readFile(file.localPath));
    }
  }

  private async ensurePersistentFile(sandbox: BlaxelSandboxLike, remotePath: string, content: string) {
    const tempPath = path.posix.join(REMOTE_RUN, `seed-${Buffer.from(remotePath).toString("base64url")}`);
    await sandbox.fs.write(tempPath, content);
    await sandbox.process.exec({
      command: `mkdir -p ${shellQuote(path.posix.dirname(remotePath))} && if [ ! -f ${shellQuote(remotePath)} ]; then cp ${shellQuote(tempPath)} ${shellQuote(remotePath)}; fi`,
      timeout: this.commandTimeoutSec,
      waitForCompletion: true,
    });
  }
}
