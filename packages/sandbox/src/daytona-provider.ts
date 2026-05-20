import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { Daytona, type DaytonaConfig } from "@daytonaio/sdk";
import { idSegmentSchema, nowIso, type RunEvent, type RuntimeWakePayload } from "@poc/shared";
import type { AgentRuntimeConfig, ExecInput, SandboxHandle, SandboxProvider, StartRunInput } from "./types.js";

export type DaytonaVolumeLike = {
  id: string;
  name?: string;
};

export type DaytonaSandboxLike = {
  id: string;
  fs: {
    uploadFile(content: Buffer | string, remotePath: string, timeout?: number): Promise<void>;
  };
  process: {
    executeCommand(
      command: string,
      cwd?: string,
      env?: Record<string, string>,
      timeout?: number,
    ): Promise<{ exitCode: number; result: string; artifacts?: { stdout?: string } }>;
    createSession?(sessionId: string): Promise<void>;
    executeSessionCommand?(
      sessionId: string,
      req: { command: string; runAsync?: boolean; suppressInputEcho?: boolean },
      timeout?: number,
    ): Promise<{ cmdId?: string; exitCode?: number; stdout?: string; output?: string }>;
    getSessionCommandLogs?(
      sessionId: string,
      commandId: string,
      onStdout: (chunk: string) => void,
      onStderr: (chunk: string) => void,
    ): Promise<void>;
    getSessionCommand?(sessionId: string, commandId: string): Promise<{ exitCode?: number }>;
    deleteSession?(sessionId: string): Promise<void>;
  };
  delete(timeout?: number): Promise<void>;
};

export type DaytonaClientLike = {
  volume: {
    get(name: string, create?: boolean): Promise<DaytonaVolumeLike>;
  };
  create(params?: unknown, options?: { timeout?: number }): Promise<DaytonaSandboxLike>;
};

export type DaytonaSandboxProviderOptions = {
  client?: DaytonaClientLike;
  apiKey?: string | undefined;
  jwtToken?: string | undefined;
  organizationId?: string | undefined;
  apiUrl?: string | undefined;
  target?: string | undefined;
  volumeName?: string | undefined;
  image?: string | undefined;
  snapshot?: string | undefined;
  createTimeoutSec?: number;
  commandTimeoutSec?: number;
  deleteTimeoutSec?: number;
  volumeReadyPollMs?: number;
  agentRuntime?: AgentRuntimeConfig;
};

type DaytonaHandle = SandboxHandle & {
  sandbox: DaytonaSandboxLike;
  localSharedPath: string;
};

const REMOTE_AGENT_HOME = "/agent-home";
const REMOTE_WORKSPACE = "/workspace";
const REMOTE_SHARED = "/agentruntime/shared";
const REMOTE_HARNESS = "/agentruntime/harness";
const REMOTE_RUN = "/run";
const REMOTE_WAKE = "/run/wake.json";
const REMOTE_RUNTIME_ENV = "/run/runtime-env.sh";
const DEFAULT_VOLUME_NAME = "poc-ephemeral-agent-sandbox";
const DEFAULT_IMAGE = "node:22-bookworm";
const DEFAULT_VOLUME_READY_POLL_MS = 2_000;
const DEFAULT_AGENT_RUNTIME: AgentRuntimeConfig = {
  mode: "mock",
  pi: {
    model: "openai/gpt-5.5",
    thinkingLevel: "medium",
  },
};

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isPendingVolumeCreateError(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  return /volume .*not in a ready state/i.test(message) && /pending_create/i.test(message);
}

function createDaytonaClient(options: DaytonaSandboxProviderOptions): DaytonaClientLike {
  const config: DaytonaConfig = {};
  if (options.apiKey) config.apiKey = options.apiKey;
  if (options.jwtToken) config.jwtToken = options.jwtToken;
  if (options.organizationId) config.organizationId = options.organizationId;
  if (options.apiUrl) config.apiUrl = options.apiUrl;
  if (options.target) config.target = options.target;
  return new Daytona(config) as unknown as DaytonaClientLike;
}

class AsyncEventQueue<T> {
  private readonly values: T[] = [];
  private readonly waiters: Array<(result: IteratorResult<T>) => void> = [];
  private done = false;
  private failure: unknown;

  push(value: T) {
    const waiter = this.waiters.shift();
    if (waiter) {
      waiter({ done: false, value });
      return;
    }
    this.values.push(value);
  }

  end() {
    this.done = true;
    while (this.waiters.length > 0) {
      this.waiters.shift()?.({ done: true, value: undefined });
    }
  }

  error(error: unknown) {
    this.failure = error;
    this.end();
  }

  async *[Symbol.asyncIterator](): AsyncIterableIterator<T> {
    while (true) {
      if (this.values.length > 0) {
        yield this.values.shift() as T;
        continue;
      }
      if (this.failure) throw this.failure;
      if (this.done) return;

      const result = await new Promise<IteratorResult<T>>((resolve) => this.waiters.push(resolve));
      if (result.done) {
        if (this.failure) throw this.failure;
        return;
      }
      yield result.value;
    }
  }
}

function parseJsonlLines(lines: string[], runId: string): RunEvent[] {
  const events: RunEvent[] = [];
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const parsed = JSON.parse(trimmed) as RunEvent;
      if (parsed && typeof parsed === "object" && "type" in parsed && "runId" in parsed) {
        events.push(parsed);
        continue;
      }
    } catch {
      // Non-JSON lines are retained as stdout events.
    }
    events.push({ type: "stdout", runId, timestamp: nowIso(), data: trimmed });
  }
  return events;
}

function createJsonlEventParser(runId: string) {
  let buffered = "";
  return {
    push(chunk: string): RunEvent[] {
      buffered += chunk;
      const lines = buffered.split(/\r?\n/);
      buffered = lines.pop() ?? "";
      return parseJsonlLines(lines, runId);
    },
    flush(): RunEvent[] {
      const events = parseJsonlLines([buffered], runId);
      buffered = "";
      return events;
    },
  };
}

function parseJsonlEvents(output: string, runId: string): RunEvent[] {
  return parseJsonlLines(output.split(/\r?\n/), runId);
}

function remoteRuntimeSource() {
  return String.raw`import { appendFile, mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

function nowIso() {
  return new Date().toISOString();
}

function emit(event) {
  process.stdout.write(JSON.stringify(event) + "\n");
}

const payloadPath = process.argv[2] || "/run/wake.json";
const payload = JSON.parse(await readFile(payloadPath, "utf8"));
const { run, wakeEvent, agentHomePath, workspacePath, sharedPath } = payload;

emit({ type: "runtime_started", runId: run.id, timestamp: nowIso() });

const identity = await readFile(path.join(agentHomePath, "IDENTITY.md"), "utf8");
const workspaceInstructions = await readFile(path.join(workspacePath, "AGENTS.md"), "utf8");
const sharedEntries = await readdir(sharedPath);

emit({
  type: "stdout",
  runId: run.id,
  timestamp: nowIso(),
  data: "Loaded identity (" + identity.length + " chars), workspace instructions (" + workspaceInstructions.length + " chars), shared entries: " + sharedEntries.join(", "),
});

await appendFile(path.join(agentHomePath, "MEMORY.md"), "\n## " + nowIso() + " " + run.id + "\n\nHandled wake: " + wakeEvent.message + "\n", "utf8");
emit({ type: "file_changed", runId: run.id, timestamp: nowIso(), path: path.join(agentHomePath, "MEMORY.md") });

const notesDir = path.join(workspacePath, "notes");
await mkdir(notesDir, { recursive: true });
const notePath = path.join(notesDir, run.id + ".md");
await writeFile(notePath, [
  "# Run " + run.id,
  "",
  "Message: " + wakeEvent.message,
  "Agent: " + run.agentId,
  "Workspace: " + run.workspaceId,
  "Shared bundle: " + run.sharedBundleVersion,
  "",
].join("\n"), "utf8");
emit({ type: "file_changed", runId: run.id, timestamp: nowIso(), path: notePath });
emit({ type: "artifact_created", runId: run.id, timestamp: nowIso(), path: notePath });

if (run.taskId) {
  emit({ type: "task_updated", runId: run.id, timestamp: nowIso(), taskId: run.taskId, status: "done" });
}

emit({ type: "run_finished", runId: run.id, timestamp: nowIso(), status: "succeeded" });
`;
}

function remotePiRuntimeSource(config: AgentRuntimeConfig) {
  return String.raw`import { appendFile, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { AuthStorage, createAgentSession, ModelRegistry, SessionManager } from "@earendil-works/pi-coding-agent";

const piConfig = ${JSON.stringify(config.pi, null, 2)};

function nowIso() {
  return new Date().toISOString();
}

function emit(event) {
  process.stdout.write(JSON.stringify(event) + "\n");
}

async function readOptional(filePath) {
  try {
    return await readFile(filePath, "utf8");
  } catch (error) {
    if (error && error.code === "ENOENT") return "";
    throw error;
  }
}

function splitModelName(modelName) {
  const separator = modelName.indexOf("/");
  if (separator === -1) return { provider: undefined, modelId: modelName };
  return {
    provider: modelName.slice(0, separator),
    modelId: modelName.slice(separator + 1),
  };
}

function messageContentToText(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return JSON.stringify(content);
  return content
    .map((part) => {
      if (part && part.type === "text") return part.text;
      if (part && part.type) return "[" + part.type + "]";
      return "";
    })
    .filter(Boolean)
    .join("\n");
}

async function copyTree(sourceDir, destinationDir) {
  let entries;
  try {
    entries = await readdir(sourceDir, { withFileTypes: true });
  } catch (error) {
    if (error && error.code === "ENOENT") return;
    throw error;
  }
  await mkdir(destinationDir, { recursive: true });
  for (const entry of entries) {
    const sourcePath = path.join(sourceDir, entry.name);
    const destinationPath = path.join(destinationDir, entry.name);
    if (entry.isDirectory()) {
      await copyTree(sourcePath, destinationPath);
    } else if (entry.isFile()) {
      await mkdir(path.dirname(destinationPath), { recursive: true });
      await writeFile(destinationPath, await readFile(sourcePath));
    }
  }
}

const payloadPath = process.argv[2] || "/run/wake.json";
const payload = JSON.parse(await readFile(payloadPath, "utf8"));
const { run, wakeEvent, agentHomePath, workspacePath, sharedPath } = payload;
const piHome = "/agent-home/pi";
const workspaceSessionDir = path.join(piHome, "sessions", run.workspaceId);

emit({ type: "runtime_started", runId: run.id, timestamp: nowIso() });

await mkdir(workspaceSessionDir, { recursive: true });
await mkdir(path.join(workspacePath, "notes"), { recursive: true });
await mkdir(path.join(workspacePath, ".agents"), { recursive: true });

await copyTree(path.join(sharedPath, "skills"), path.join(workspacePath, ".agents", "skills"));

const identity = await readOptional(path.join(agentHomePath, "IDENTITY.md"));
const memory = await readOptional(path.join(agentHomePath, "MEMORY.md"));
const workspaceInstructions = await readOptional(path.join(workspacePath, "AGENTS.md"));
const sharedInstructions = await readOptional(path.join(sharedPath, "AGENTS.shared.md"));

emit({
  type: "stdout",
  runId: run.id,
  timestamp: nowIso(),
  data: "Starting Pi runtime with model " + piConfig.model + " and thinking level " + piConfig.thinkingLevel,
});

const authStorage = AuthStorage.create(path.join(piHome, "auth.json"));
const modelRegistry = ModelRegistry.create(authStorage, path.join(piHome, "models.json"));
const modelParts = splitModelName(piConfig.model);
const selectedModel = modelParts.provider ? modelRegistry.find(modelParts.provider, modelParts.modelId) : undefined;
if (!selectedModel) {
  throw new Error("Configured Pi model not found: " + piConfig.model);
}
const { session } = await createAgentSession({
  cwd: workspacePath,
  agentDir: piHome,
  sessionManager: SessionManager.continueRecent(workspacePath, workspaceSessionDir),
  authStorage,
  modelRegistry,
  model: selectedModel,
  thinkingLevel: piConfig.thinkingLevel,
  tools: ["read", "bash", "edit", "write", "grep", "find", "ls"],
});

session.subscribe((event) => {
  if (event.type === "agent_start") {
    emit({ type: "stdout", runId: run.id, timestamp: nowIso(), data: "Pi agent started" });
  } else if (event.type === "tool_call" || event.type === "tool_result") {
    emit({ type: "stdout", runId: run.id, timestamp: nowIso(), data: "Pi event: " + event.type });
  }
});

const prompt = [
  "You are running as a just-in-time agent inside an ephemeral Daytona sandbox.",
  "",
  "Use /workspace as the durable business workspace.",
  "Use /agent-home as durable agent state.",
  "",
  "Agent identity:",
  identity,
  "",
  "Agent memory:",
  memory,
  "",
  "Workspace instructions:",
  workspaceInstructions,
  "",
  "Shared instructions:",
  sharedInstructions,
  "",
  "Wake source: " + wakeEvent.source,
  "Wake message:",
  wakeEvent.message,
].join("\n");

await session.prompt(prompt, { source: "rpc" });
const lastAssistant = [...session.messages].reverse().find((message) => message.role === "assistant");
const responseText = lastAssistant ? messageContentToText(lastAssistant.content) : "Pi completed without an assistant text response.";

emit({ type: "stdout", runId: run.id, timestamp: nowIso(), data: responseText });

const notePath = path.join(workspacePath, "notes", run.id + ".md");
await writeFile(notePath, [
  "# Run " + run.id,
  "",
  "Message: " + wakeEvent.message,
  "",
  "Pi response:",
  "",
  responseText,
  "",
].join("\n"), "utf8");
emit({ type: "file_changed", runId: run.id, timestamp: nowIso(), path: notePath });
emit({ type: "artifact_created", runId: run.id, timestamp: nowIso(), path: notePath });

await appendFile(path.join(agentHomePath, "MEMORY.md"), "\n## " + nowIso() + " " + run.id + "\n\nHandled wake with Pi: " + wakeEvent.message + "\n", "utf8");
emit({ type: "file_changed", runId: run.id, timestamp: nowIso(), path: path.join(agentHomePath, "MEMORY.md") });

if (run.taskId) {
  emit({ type: "task_updated", runId: run.id, timestamp: nowIso(), taskId: run.taskId, status: "done" });
}

emit({ type: "run_finished", runId: run.id, timestamp: nowIso(), status: "succeeded" });
`;
}

function remotePiPackageJson() {
  return `${JSON.stringify(
    {
      type: "module",
      dependencies: {
        "@earendil-works/pi-coding-agent": "0.75.4",
      },
    },
    null,
    2,
  )}\n`;
}

function runtimeCommandEnv(): Record<string, string> {
  const names = [
    "ANTHROPIC_API_KEY",
    "OPENAI_API_KEY",
    "AZURE_OPENAI_API_KEY",
    "DEEPSEEK_API_KEY",
    "GOOGLE_API_KEY",
    "GEMINI_API_KEY",
    "OPENROUTER_API_KEY",
    "VERCEL_AI_GATEWAY_API_KEY",
    "GITHUB_TOKEN",
  ];
  const env: Record<string, string> = {
    PI_CODING_AGENT_DIR: "/agent-home/pi",
    PI_CODING_AGENT_SESSION_DIR: "/agent-home/pi/sessions",
    PI_SKIP_VERSION_CHECK: "1",
    PI_TELEMETRY: "0",
  };
  for (const name of names) {
    const value = process.env[name];
    if (value) env[name] = value;
  }
  return env;
}

function supportsSessionStreaming(process: DaytonaSandboxLike["process"]) {
  return (
    typeof process.createSession === "function" &&
    typeof process.executeSessionCommand === "function" &&
    typeof process.getSessionCommandLogs === "function" &&
    typeof process.getSessionCommand === "function"
  );
}

function runtimeCommandEnvSource() {
  return `${Object.entries(runtimeCommandEnv())
    .map(([key, value]) => `export ${key}=${shellQuote(value)}`)
    .join("\n")}\n`;
}

function withShellCwdAndEnvFile(command: string, cwd: string) {
  return `cd ${shellQuote(cwd)} && . ${shellQuote(REMOTE_RUNTIME_ENV)} && ${command}`;
}

async function listFilesRecursive(root: string): Promise<Array<{ localPath: string; relativePath: string }>> {
  const entries: Array<{ localPath: string; relativePath: string }> = [];

  async function walk(current: string) {
    for (const name of await readdir(current)) {
      const localPath = path.join(current, name);
      const info = await stat(localPath);
      if (info.isDirectory()) {
        await walk(localPath);
      } else if (info.isFile()) {
        entries.push({
          localPath,
          relativePath: path.relative(root, localPath).split(path.sep).join("/"),
        });
      }
    }
  }

  await walk(root);
  return entries;
}

function withRemoteRuntimePaths(payload: RuntimeWakePayload): RuntimeWakePayload {
  return {
    ...payload,
    agentHomePath: REMOTE_AGENT_HOME,
    workspacePath: REMOTE_WORKSPACE,
    sharedPath: REMOTE_SHARED,
    runToken: REMOTE_WAKE,
  };
}

function assertSafeDaytonaId(kind: "agentId" | "workspaceId", value: string) {
  const parsed = idSegmentSchema.safeParse(value);
  if (!parsed.success) throw new Error(`Invalid Daytona ${kind}: must be a safe path segment`);
}

export class DaytonaSandboxProvider implements SandboxProvider {
  readonly name = "daytona" as const;
  private readonly client: DaytonaClientLike;
  private readonly volumeName: string;
  private readonly image: string;
  private readonly snapshot: string | null;
  private readonly createTimeoutSec: number;
  private readonly commandTimeoutSec: number;
  private readonly deleteTimeoutSec: number;
  private readonly volumeReadyPollMs: number;
  private readonly agentRuntime: AgentRuntimeConfig;
  private readonly clientConfig: Pick<
    DaytonaSandboxProviderOptions,
    "apiKey" | "jwtToken" | "organizationId" | "apiUrl" | "target"
  >;

  constructor(options: DaytonaSandboxProviderOptions = {}) {
    this.client = options.client ?? createDaytonaClient(options);
    this.clientConfig = {
      ...(options.apiKey ? { apiKey: options.apiKey } : {}),
      ...(options.jwtToken ? { jwtToken: options.jwtToken } : {}),
      ...(options.organizationId ? { organizationId: options.organizationId } : {}),
      ...(options.apiUrl ? { apiUrl: options.apiUrl } : {}),
      ...(options.target ? { target: options.target } : {}),
    };
    this.volumeName = options.volumeName ?? DEFAULT_VOLUME_NAME;
    this.image = options.image ?? DEFAULT_IMAGE;
    this.snapshot = options.snapshot ?? null;
    this.createTimeoutSec = options.createTimeoutSec ?? 120;
    this.commandTimeoutSec = options.commandTimeoutSec ?? 120;
    this.deleteTimeoutSec = options.deleteTimeoutSec ?? 60;
    this.volumeReadyPollMs = options.volumeReadyPollMs ?? DEFAULT_VOLUME_READY_POLL_MS;
    this.agentRuntime = options.agentRuntime ?? DEFAULT_AGENT_RUNTIME;
  }

  getAgentRuntimeConfig(): AgentRuntimeConfig {
    return this.agentRuntime;
  }

  getClientConfig(): Pick<DaytonaSandboxProviderOptions, "apiKey" | "jwtToken" | "organizationId" | "apiUrl" | "target"> {
    return this.clientConfig;
  }

  async startRun(input: StartRunInput): Promise<DaytonaHandle> {
    assertSafeDaytonaId("agentId", input.agentId);
    assertSafeDaytonaId("workspaceId", input.workspaceId);

    const volume = await this.client.volume.get(this.volumeName, true);
    const createParams = {
      name: `poc-${input.runId}`.slice(0, 63),
      ephemeral: true,
      autoStopInterval: 15,
      autoArchiveInterval: 0,
      autoDeleteInterval: 0,
      labels: {
        app: "poc-ephemeral-agent-sandbox",
        runId: input.runId,
      },
      ...(this.snapshot ? { snapshot: this.snapshot } : { image: this.image }),
      volumes: [
        { volumeId: volume.id, mountPath: REMOTE_AGENT_HOME, subpath: `agents/${input.agentId}` },
        { volumeId: volume.id, mountPath: REMOTE_WORKSPACE, subpath: `workspaces/${input.workspaceId}` },
      ],
    };
    const sandbox = await this.createSandboxWhenVolumeReady(createParams);

    return {
      provider: this.name,
      sandboxId: sandbox.id,
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

  private async createSandboxWhenVolumeReady(params: unknown) {
    const deadline = Date.now() + this.createTimeoutSec * 1_000;
    for (;;) {
      try {
        return await this.client.create(params, { timeout: this.createTimeoutSec });
      } catch (error) {
        if (!isPendingVolumeCreateError(error) || Date.now() + this.volumeReadyPollMs > deadline) {
          throw error;
        }
        await sleep(this.volumeReadyPollMs);
      }
    }
  }

  async *exec(input: ExecInput): AsyncIterable<RunEvent> {
    const handle = input.handle as DaytonaHandle;
    if (!handle.sandbox) throw new Error("Daytona handle is missing sandbox instance");

    await this.prepareRemoteRuntime(handle.sandbox, input.payload, handle.localSharedPath);
    if (this.agentRuntime.mode === "pi") {
      const installResult = await handle.sandbox.process.executeCommand(
        "npm install --omit=dev",
        REMOTE_HARNESS,
        runtimeCommandEnv(),
        this.commandTimeoutSec,
      );
      if (installResult.exitCode !== 0) {
        const output = installResult.artifacts?.stdout ?? installResult.result ?? "";
        throw new Error(`Pi dependency install failed with code ${installResult.exitCode}: ${output}`);
      }
    }

    const command = `node ${shellQuote(path.posix.join(REMOTE_HARNESS, "run.mjs"))} ${shellQuote(REMOTE_WAKE)}`;
    if (supportsSessionStreaming(handle.sandbox.process)) {
      yield* this.execStreamingSession(handle.sandbox, command, input.payload.run.id);
      return;
    }

    yield* this.execBufferedCommand(handle.sandbox, command, input.payload.run.id);
  }

  async stop(handle: SandboxHandle): Promise<void> {
    const daytonaHandle = handle as DaytonaHandle;
    if (daytonaHandle.sandbox) {
      try {
        await daytonaHandle.sandbox.process.executeCommand(
          `rm -f ${shellQuote(REMOTE_RUNTIME_ENV)}`,
          undefined,
          undefined,
          this.commandTimeoutSec,
        );
      } catch {
        // Sandbox deletion is the authoritative cleanup path.
      }
      await daytonaHandle.sandbox.delete(this.deleteTimeoutSec);
    }
  }

  private async prepareRemoteRuntime(sandbox: DaytonaSandboxLike, payload: RuntimeWakePayload, localSharedPath: string) {
    await sandbox.process.executeCommand(
      [
        "mkdir -p",
        shellQuote(REMOTE_HARNESS),
        shellQuote(REMOTE_SHARED),
        shellQuote(REMOTE_RUN),
        shellQuote(path.posix.join(REMOTE_AGENT_HOME, "sessions")),
        shellQuote(path.posix.join(REMOTE_WORKSPACE, "notes")),
        shellQuote(path.posix.join(REMOTE_WORKSPACE, "artifacts")),
        shellQuote(path.posix.join(REMOTE_WORKSPACE, "crm")),
      ].join(" "),
      undefined,
      undefined,
      this.commandTimeoutSec,
    );

    const runtimeSource =
      this.agentRuntime.mode === "pi" ? remotePiRuntimeSource(this.agentRuntime) : remoteRuntimeSource();
    await sandbox.fs.uploadFile(Buffer.from(runtimeSource, "utf8"), path.posix.join(REMOTE_HARNESS, "run.mjs"));
    if (this.agentRuntime.mode === "pi") {
      await sandbox.fs.uploadFile(Buffer.from(remotePiPackageJson(), "utf8"), path.posix.join(REMOTE_HARNESS, "package.json"));
    }
    await sandbox.fs.uploadFile(Buffer.from(JSON.stringify(withRemoteRuntimePaths(payload), null, 2), "utf8"), REMOTE_WAKE);
    await sandbox.fs.uploadFile(Buffer.from(runtimeCommandEnvSource(), "utf8"), REMOTE_RUNTIME_ENV);
    await sandbox.process.executeCommand(`chmod 600 ${shellQuote(REMOTE_RUNTIME_ENV)}`, undefined, undefined, this.commandTimeoutSec);

    await this.uploadSharedBundle(sandbox, localSharedPath);
    await this.ensurePersistentFile(sandbox, path.posix.join(REMOTE_AGENT_HOME, "IDENTITY.md"), "# Agent Identity\n\nYou are the default PoC workspace agent.\n");
    await this.ensurePersistentFile(sandbox, path.posix.join(REMOTE_AGENT_HOME, "MEMORY.md"), "# Agent Memory\n\n");
    await this.ensurePersistentFile(sandbox, path.posix.join(REMOTE_AGENT_HOME, "state.json"), '{\n  "version": 1\n}\n');
    await this.ensurePersistentFile(sandbox, path.posix.join(REMOTE_WORKSPACE, "AGENTS.md"), "# Workspace Instructions\n\nThis workspace represents one business or project operated by the agent.\n");
    await this.ensurePersistentFile(sandbox, path.posix.join(REMOTE_WORKSPACE, "TASKS.md"), "# Tasks\n\nCanonical tasks live in the control plane. This file is a local mirror for PoC visibility.\n");
  }

  private async *execBufferedCommand(sandbox: DaytonaSandboxLike, command: string, runId: string): AsyncIterable<RunEvent> {
    const result = await sandbox.process.executeCommand(
      command,
      REMOTE_WORKSPACE,
      runtimeCommandEnv(),
      this.commandTimeoutSec,
    );

    const stdout = result.artifacts?.stdout ?? result.result ?? "";
    for (const event of parseJsonlEvents(stdout, runId)) {
      yield event;
    }

    if (result.exitCode !== 0) {
      throw new Error(`Daytona runtime exited with code ${result.exitCode}`);
    }
  }

  private async *execStreamingSession(sandbox: DaytonaSandboxLike, command: string, runId: string): AsyncIterable<RunEvent> {
    const sessionId = `run-${runId}`.replace(/[^A-Za-z0-9_.-]/g, "-").slice(0, 63);
    await sandbox.process.createSession?.(sessionId);

    try {
      const response = await sandbox.process.executeSessionCommand?.(
        sessionId,
        {
          command: withShellCwdAndEnvFile(command, REMOTE_WORKSPACE),
          runAsync: true,
          suppressInputEcho: true,
        },
        this.commandTimeoutSec,
      );
      const commandId = response?.cmdId;
      if (!commandId) {
        throw new Error("Daytona session command did not return a command id");
      }

      const events = new AsyncEventQueue<RunEvent>();
      const parser = createJsonlEventParser(runId);
      const logsPromise = sandbox.process
        .getSessionCommandLogs?.(
          sessionId,
          commandId,
          (chunk) => {
            for (const event of parser.push(chunk)) events.push(event);
          },
          (chunk) => {
            if (chunk.trim()) events.push({ type: "stderr", runId, timestamp: nowIso(), data: chunk.trimEnd() });
          },
        )
        .then(() => {
          for (const event of parser.flush()) events.push(event);
          events.end();
        })
        .catch((error: unknown) => {
          events.error(error);
        });

      for await (const event of events) {
        yield event;
      }
      await logsPromise;

      const commandInfo = await sandbox.process.getSessionCommand?.(sessionId, commandId);
      if (commandInfo?.exitCode === undefined) {
        throw new Error("Daytona runtime command finished without an exit code");
      }
      if (commandInfo.exitCode !== 0) {
        throw new Error(`Daytona runtime exited with code ${commandInfo.exitCode}`);
      }
    } finally {
      await sandbox.process.deleteSession?.(sessionId);
    }
  }

  private async uploadSharedBundle(sandbox: DaytonaSandboxLike, sharedPath: string) {
    for (const file of await listFilesRecursive(sharedPath)) {
      const remotePath = path.posix.join(REMOTE_SHARED, file.relativePath);
      await sandbox.process.executeCommand(`mkdir -p ${shellQuote(path.posix.dirname(remotePath))}`);
      await sandbox.fs.uploadFile(await readFile(file.localPath), remotePath);
    }
  }

  private async ensurePersistentFile(sandbox: DaytonaSandboxLike, remotePath: string, content: string) {
    const tempPath = path.posix.join(REMOTE_RUN, `seed-${Buffer.from(remotePath).toString("base64url")}`);
    await sandbox.fs.uploadFile(Buffer.from(content, "utf8"), tempPath);
    await sandbox.process.executeCommand(
      `mkdir -p ${shellQuote(path.posix.dirname(remotePath))} && if [ ! -f ${shellQuote(remotePath)} ]; then cp ${shellQuote(tempPath)} ${shellQuote(remotePath)}; fi`,
      undefined,
      undefined,
      this.commandTimeoutSec,
    );
  }
}
