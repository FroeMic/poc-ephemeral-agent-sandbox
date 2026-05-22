import { readFile } from "node:fs/promises";
import path from "node:path";
import { Sandbox, Volume } from "e2b";
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

export type E2BVolumeLike = {
  name: string;
  volumeId?: string;
};

export type E2BSandboxLike = {
  sandboxId: string;
  files: {
    write(remotePath: string, content: string | ArrayBuffer | Blob | ReadableStream): Promise<unknown>;
  };
  commands: {
    run(
      command: string,
      options?: { cwd?: string; envs?: Record<string, string>; timeoutMs?: number },
    ): Promise<{ exitCode: number; stdout: string; stderr?: string; error?: string }>;
  };
  kill(options?: { requestTimeoutMs?: number }): Promise<void>;
};

export type E2BClientLike = {
  Sandbox: {
    create(options?: unknown): Promise<E2BSandboxLike>;
  };
  Volume: {
    create(name: string, options?: unknown): Promise<E2BVolumeLike>;
    list(options?: unknown): Promise<E2BVolumeLike[]>;
  };
};

export type E2BSandboxProviderOptions = {
  client?: E2BClientLike;
  apiKey?: string | undefined;
  template?: string | undefined;
  volumePrefix?: string | undefined;
  useVolumes?: boolean;
  storageMode?: "volumes" | "ephemeral" | "archil";
  archil?: {
    mountToken?: string | undefined;
    disk?: string | undefined;
    region?: string | undefined;
    mountPath?: string | undefined;
  };
  createTimeoutSec?: number;
  commandTimeoutSec?: number;
  deleteTimeoutSec?: number;
  agentRuntime?: AgentRuntimeConfig;
};

type E2BHandle = SandboxHandle & {
  sandbox: E2BSandboxLike;
  localSharedPath: string;
  remotePaths: E2BRemotePaths;
};

type E2BRemotePaths = {
  agentHome: string;
  workspace: string;
  shared: string;
  harness: string;
  run: string;
  wake: string;
};

type E2BArchilConfig = {
  mountToken: string;
  disk: string;
  region: string;
  mountPath: string;
};

const DEFAULT_TEMPLATE = "base";
const DEFAULT_VOLUME_PREFIX = "poc-ephemeral-agent-sandbox";
const DEFAULT_AGENT_RUNTIME: AgentRuntimeConfig = {
  mode: "mock",
  pi: {
    model: "openai/gpt-5.5",
    thinkingLevel: "medium",
  },
};

function createE2BClient(): E2BClientLike {
  return { Sandbox, Volume } as unknown as E2BClientLike;
}

function assertSafeId(kind: "agentId" | "workspaceId", value: string) {
  const parsed = idSegmentSchema.safeParse(value);
  if (!parsed.success) throw new Error(`Invalid E2B ${kind}: must be a safe path segment`);
}

function volumeName(prefix: string, kind: "agent" | "workspace", id: string) {
  return `${prefix}-${kind}-${id}`.replace(/[^A-Za-z0-9_-]/g, "-").slice(0, 63);
}

function bufferToArrayBuffer(buffer: Buffer): ArrayBuffer {
  return buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength) as ArrayBuffer;
}

function formatCommandError(error: unknown) {
  let message: string;
  if (error instanceof Error) {
    message = error.message;
  } else if (error && typeof error === "object" && "message" in error && typeof error.message === "string") {
    message = error.message;
  } else {
    try {
      message = JSON.stringify(error);
    } catch {
      message = String(error);
    }
  }
  return message.replace(/(?:dtn|sk|sk-proj|e2b|bl|adt)_[A-Za-z0-9_-]+/g, "[redacted]");
}

function redactCommand(command: string) {
  return command
    .replace(/ARCHIL_MOUNT_TOKEN='[^']*'/g, "ARCHIL_MOUNT_TOKEN='[redacted]'")
    .replace(/(?:dtn|sk|sk-proj|e2b|bl|adt)_[A-Za-z0-9_-]+/g, "[redacted]");
}

function shellDoubleQuote(value: string): string {
  return `"${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"').replaceAll("$", "\\$").replaceAll("`", "\\`")}"`;
}

function inspectableShellCommand(command: string) {
  return [
    "set +e",
    `${command} 2>&1`,
    "code=$?",
    'echo "__EXIT_CODE__:${code}"',
    "exit 0",
  ].join("; ");
}

function parseInspectableCommandResult(result: { exitCode?: number; stdout: string; stderr?: string }) {
  const combined = [result.stdout, result.stderr].filter(Boolean).join("\n");
  const match = combined.match(/__EXIT_CODE__:(\d+)/);
  return {
    exitCode: match ? Number.parseInt(match[1] ?? "1", 10) : (result.exitCode ?? 1),
    output: combined.replace(/\n?__EXIT_CODE__:\d+\s*$/, "").trim(),
  };
}

function commandResultOutput(result: { stdout?: string; stderr?: string; error?: string }) {
  return [result.stdout, result.stderr, result.error].filter(Boolean).join("\n").trim();
}

async function runCheckedCommand(
  runner: (command: string) => Promise<{ exitCode: number; stdout: string; stderr?: string; error?: string }>,
  description: string,
  command: string,
) {
  let result;
  try {
    result = await runner(command);
  } catch (firstError) {
    try {
      result = await runner(`bash -lc ${shellDoubleQuote(inspectableShellCommand(command))}`);
    } catch (secondError) {
      throw new Error(
        `E2B command failed while ${description}: ${formatCommandError(secondError || firstError)}. Command: ${redactCommand(command)}`,
      );
    }
    const inspected = parseInspectableCommandResult(result);
    if (inspected.exitCode === 0) return result;
    throw new Error(
      `E2B command failed while ${description}: ${formatCommandError(inspected.output || commandResultOutput(result) || "exit status " + inspected.exitCode)}. Command: ${redactCommand(command)}`,
    );
  }
  if (result.exitCode !== 0) {
    throw new Error(
      `E2B command failed while ${description}: ${formatCommandError(commandResultOutput(result) || "exit status " + result.exitCode)}. Command: ${redactCommand(command)}`,
    );
  }
  return result;
}

export class E2BSandboxProvider implements SandboxProvider {
  readonly name = "e2b" as const;
  private readonly client: E2BClientLike;
  private readonly apiKey: string | undefined;
  private readonly template: string;
  private readonly volumePrefix: string;
  private readonly storageMode: "volumes" | "ephemeral" | "archil";
  private readonly archil: E2BArchilConfig;
  private readonly createTimeoutSec: number;
  private readonly commandTimeoutSec: number;
  private readonly deleteTimeoutSec: number;
  private readonly agentRuntime: AgentRuntimeConfig;

  constructor(options: E2BSandboxProviderOptions = {}) {
    this.client = options.client ?? createE2BClient();
    this.apiKey = options.apiKey;
    this.template = options.template ?? DEFAULT_TEMPLATE;
    this.volumePrefix = options.volumePrefix ?? DEFAULT_VOLUME_PREFIX;
    this.storageMode = options.storageMode ?? (options.useVolumes === false ? "ephemeral" : "volumes");
    this.archil = {
      mountToken: options.archil?.mountToken ?? "",
      disk: options.archil?.disk ?? "",
      region: options.archil?.region ?? "",
      mountPath: options.archil?.mountPath ?? "/home/user/archil",
    };
    this.createTimeoutSec = options.createTimeoutSec ?? 120;
    this.commandTimeoutSec = options.commandTimeoutSec ?? 900;
    this.deleteTimeoutSec = options.deleteTimeoutSec ?? 60;
    this.agentRuntime = options.agentRuntime ?? DEFAULT_AGENT_RUNTIME;
  }

  getAgentRuntimeConfig(): AgentRuntimeConfig {
    return this.agentRuntime;
  }

  getClientConfig(): { apiKey?: string } {
    return {
      ...(this.apiKey ? { apiKey: this.apiKey } : {}),
    };
  }

  async startRun(input: StartRunInput): Promise<E2BHandle> {
    assertSafeId("agentId", input.agentId);
    assertSafeId("workspaceId", input.workspaceId);
    if (this.storageMode === "archil") {
      this.assertArchilConfig();
    }

    const volumeMounts = this.storageMode === "volumes" ? await this.createVolumeMounts(input) : undefined;
    const sandbox = await this.client.Sandbox.create({
      ...(this.apiKey ? { apiKey: this.apiKey } : {}),
      template: this.template,
      requestTimeoutMs: this.createTimeoutSec * 1_000,
      timeoutMs: this.commandTimeoutSec * 1_000,
      metadata: {
        app: "poc-ephemeral-agent-sandbox",
        runId: input.runId,
      },
      ...(volumeMounts ? { volumeMounts } : {}),
    });

    return {
      provider: this.name,
      sandboxId: sandbox.sandboxId,
      sandbox,
      localSharedPath: input.sharedPath,
      remotePaths: this.remotePaths(),
      runtimePaths: {
        agentHomePath: this.remotePaths().agentHome,
        workspacePath: this.remotePaths().workspace,
        sharedPath: this.remotePaths().shared,
        runPath: this.remotePaths().run,
        wakePath: this.remotePaths().wake,
      },
    };
  }

  async *exec(input: ExecInput): AsyncIterable<RunEvent> {
    const handle = input.handle as E2BHandle;
    if (!handle.sandbox) throw new Error("E2B handle is missing sandbox instance");

    await this.prepareRemoteRuntime(handle.sandbox, input.payload, handle.localSharedPath, handle.remotePaths);
    if (this.agentRuntime.mode === "pi" && this.agentRuntime.pi.installDeps !== false) {
      const installResult = await handle.sandbox.commands.run("npm install --omit=dev", {
        cwd: handle.remotePaths.harness,
        envs: runtimeCommandEnv(),
        timeoutMs: this.commandTimeoutSec * 1_000,
      });
      if (installResult.exitCode !== 0) {
        throw new Error(`Pi dependency install failed with code ${installResult.exitCode}: ${installResult.stderr ?? installResult.stdout}`);
      }
    }

    const runtimeCommand = `node ${shellQuote(path.posix.join(handle.remotePaths.harness, "run.mjs"))} ${shellQuote(handle.remotePaths.wake)}`;
    const result = await handle.sandbox.commands.run(`bash -lc ${shellDoubleQuote(inspectableShellCommand(runtimeCommand))}`, {
      cwd: handle.remotePaths.workspace,
      envs: runtimeCommandEnv(),
      timeoutMs: this.commandTimeoutSec * 1_000,
    });

    const inspected = parseInspectableCommandResult(result);
    for (const event of parseJsonlEvents(inspected.output, input.payload.run.id)) {
      yield event;
    }
    if (inspected.exitCode !== 0) {
      throw new Error(`E2B runtime exited with code ${inspected.exitCode}: ${formatCommandError(inspected.output || commandResultOutput(result))}`);
    }
  }

  async stop(handle: SandboxHandle): Promise<void> {
    const e2bHandle = handle as E2BHandle;
    if (e2bHandle.sandbox) {
      try {
        if (this.storageMode === "archil") {
          await e2bHandle.sandbox.commands.run(`sudo archil unmount ${shellQuote(this.archil.mountPath)}`, {
            timeoutMs: this.commandTimeoutSec * 1_000,
          });
        }
      } catch {
        // Keep teardown best-effort; sandbox kill is the required cleanup path.
      } finally {
        await e2bHandle.sandbox.kill({ requestTimeoutMs: this.deleteTimeoutSec * 1_000 });
      }
    }
  }

  private async ensureVolume(name: string) {
    const existing = (await this.client.Volume.list(this.connectionOptions())).find((volume) => volume.name === name);
    if (existing) return existing;
    return this.client.Volume.create(name, this.connectionOptions());
  }

  private async createVolumeMounts(input: StartRunInput) {
    const agentVolume = await this.ensureVolume(volumeName(this.volumePrefix, "agent", input.agentId));
    const workspaceVolume = await this.ensureVolume(volumeName(this.volumePrefix, "workspace", input.workspaceId));
    return {
      [REMOTE_AGENT_HOME]: agentVolume,
      [REMOTE_WORKSPACE]: workspaceVolume,
    };
  }

  private connectionOptions() {
    return {
      ...(this.apiKey ? { apiKey: this.apiKey } : {}),
    };
  }

  private remotePaths(): E2BRemotePaths {
    if (this.storageMode === "volumes") {
      return {
        agentHome: REMOTE_AGENT_HOME,
        workspace: REMOTE_WORKSPACE,
        shared: REMOTE_SHARED,
        harness: REMOTE_HARNESS,
        run: REMOTE_RUN,
        wake: REMOTE_WAKE,
      };
    }
    if (this.storageMode === "archil") {
      return {
        agentHome: path.posix.join(this.archil.mountPath, "agent-home"),
        workspace: path.posix.join(this.archil.mountPath, "workspace"),
        shared: "/home/user/agentruntime/shared",
        harness: "/home/user/agentruntime/harness",
        run: "/home/user/run",
        wake: "/home/user/run/wake.json",
      };
    }
    return {
      agentHome: "/home/user/agent-home",
      workspace: "/home/user/workspace",
      shared: "/home/user/agentruntime/shared",
      harness: "/home/user/agentruntime/harness",
      run: "/home/user/run",
      wake: "/home/user/run/wake.json",
    };
  }

  private assertArchilConfig() {
    const missing = [
      this.archil.mountToken ? "" : "E2B_ARCHIL_MOUNT_TOKEN",
      this.archil.disk ? "" : "E2B_ARCHIL_DISK",
      this.archil.region ? "" : "E2B_ARCHIL_REGION",
    ].filter(Boolean);
    if (missing.length > 0) {
      throw new Error(`E2B Archil storage requires ${missing.join(", ")}`);
    }
  }

  private async mountArchil(sandbox: E2BSandboxLike) {
    const runCommand = async (description: string, command: string) => {
      return runCheckedCommand(
        (cmd) => sandbox.commands.run(cmd, { timeoutMs: this.commandTimeoutSec * 1_000 }),
        description,
        command,
      );
    };
    await runCommand("creating Archil mount directory", `sudo mkdir -p ${shellQuote(this.archil.mountPath)}`);
    await runCommand(
      "mounting Archil disk",
      [
        `sudo ARCHIL_MOUNT_TOKEN=${shellQuote(this.archil.mountToken)}`,
        "archil mount",
        shellQuote(this.archil.disk),
        shellQuote(this.archil.mountPath),
        "--region",
        shellQuote(this.archil.region),
      ].join(" "),
    );
    await runCommand("chowning Archil mount", `sudo chown -R user:user ${shellQuote(this.archil.mountPath)}`);
  }

  private async prepareRemoteRuntime(
    sandbox: E2BSandboxLike,
    payload: RuntimeWakePayload,
    localSharedPath: string,
    remotePaths: E2BRemotePaths,
  ) {
    if (this.storageMode === "archil") {
      await this.mountArchil(sandbox);
    }
    await sandbox.commands.run(
      [
        "mkdir -p",
        shellQuote(remotePaths.harness),
        shellQuote(remotePaths.shared),
        shellQuote(remotePaths.run),
        shellQuote(path.posix.join(remotePaths.agentHome, "sessions")),
        shellQuote(path.posix.join(remotePaths.workspace, "notes")),
        shellQuote(path.posix.join(remotePaths.workspace, "artifacts")),
        shellQuote(path.posix.join(remotePaths.workspace, "crm")),
      ].join(" "),
      { timeoutMs: this.commandTimeoutSec * 1_000 },
    );

    const runtimeSource =
      this.agentRuntime.mode === "pi" ? remotePiRuntimeSource(this.agentRuntime) : remoteRuntimeSource();
    await sandbox.files.write(path.posix.join(remotePaths.harness, "run.mjs"), runtimeSource);
    if (this.agentRuntime.mode === "pi") {
      await sandbox.files.write(path.posix.join(remotePaths.harness, "package.json"), remotePiPackageJson());
    }
    await sandbox.files.write(remotePaths.wake, JSON.stringify(this.withRemotePaths(payload, remotePaths), null, 2));
    await sandbox.files.write(remotePaths.run + "/runtime-env.sh", runtimeCommandEnvSource());
    await sandbox.commands.run(`chmod 600 ${shellQuote(remotePaths.run + "/runtime-env.sh")}`, {
      timeoutMs: this.commandTimeoutSec * 1_000,
    });

    await this.uploadSharedBundle(sandbox, localSharedPath, remotePaths.shared);
    await this.ensurePersistentFile(sandbox, remotePaths.run, path.posix.join(remotePaths.agentHome, "IDENTITY.md"), "# Agent Identity\n\nYou are the default PoC workspace agent.\n");
    await this.ensurePersistentFile(sandbox, remotePaths.run, path.posix.join(remotePaths.agentHome, "MEMORY.md"), "# Agent Memory\n\n");
    await this.ensurePersistentFile(sandbox, remotePaths.run, path.posix.join(remotePaths.agentHome, "state.json"), '{\n  "version": 1\n}\n');
    await this.ensurePersistentFile(sandbox, remotePaths.run, path.posix.join(remotePaths.workspace, "AGENTS.md"), "# Workspace Instructions\n\nThis workspace represents one business or project operated by the agent.\n");
    await this.ensurePersistentFile(sandbox, remotePaths.run, path.posix.join(remotePaths.workspace, "TASKS.md"), "# Tasks\n\nCanonical tasks live in the control plane. This file is a local mirror for PoC visibility.\n");
  }

  private withRemotePaths(payload: RuntimeWakePayload, remotePaths: E2BRemotePaths): RuntimeWakePayload {
    return {
      ...withRemoteRuntimePaths(payload),
      agentHomePath: remotePaths.agentHome,
      workspacePath: remotePaths.workspace,
      sharedPath: remotePaths.shared,
      runToken: remotePaths.wake,
    };
  }

  private async uploadSharedBundle(sandbox: E2BSandboxLike, sharedPath: string, remoteSharedPath: string) {
    for (const file of await listFilesRecursive(sharedPath)) {
      const remotePath = path.posix.join(remoteSharedPath, file.relativePath);
      await sandbox.files.write(remotePath, bufferToArrayBuffer(await readFile(file.localPath)));
    }
  }

  private async ensurePersistentFile(sandbox: E2BSandboxLike, remoteRunPath: string, remotePath: string, content: string) {
    const tempPath = path.posix.join(remoteRunPath, `seed-${Buffer.from(remotePath).toString("base64url")}`);
    await sandbox.files.write(tempPath, content);
    await sandbox.commands.run(
      `mkdir -p ${shellQuote(path.posix.dirname(remotePath))} && if [ ! -f ${shellQuote(remotePath)} ]; then cp ${shellQuote(tempPath)} ${shellQuote(remotePath)}; fi`,
      { timeoutMs: this.commandTimeoutSec * 1_000 },
    );
  }
}
