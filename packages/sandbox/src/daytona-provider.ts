import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { Daytona, type DaytonaConfig } from "@daytonaio/sdk";
import { nowIso, type RunEvent, type RuntimeWakePayload } from "@poc/shared";
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
  apiUrl?: string | undefined;
  target?: string | undefined;
  volumeName?: string | undefined;
  image?: string | undefined;
  snapshot?: string | undefined;
  createTimeoutSec?: number;
  commandTimeoutSec?: number;
  deleteTimeoutSec?: number;
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
const DEFAULT_VOLUME_NAME = "poc-ephemeral-agent-sandbox";
const DEFAULT_IMAGE = "node:22-bookworm";
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

function createDaytonaClient(options: DaytonaSandboxProviderOptions): DaytonaClientLike {
  const config: DaytonaConfig = {};
  if (options.apiKey) config.apiKey = options.apiKey;
  if (options.apiUrl) config.apiUrl = options.apiUrl;
  if (options.target) config.target = options.target;
  return new Daytona(config) as unknown as DaytonaClientLike;
}

function parseJsonlEvents(output: string, runId: string): RunEvent[] {
  const events: RunEvent[] = [];
  for (const line of output.split(/\r?\n/)) {
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
  return String.raw`import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
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

const payloadPath = process.argv[2] || "/run/wake.json";
const payload = JSON.parse(await readFile(payloadPath, "utf8"));
const { run, wakeEvent, agentHomePath, workspacePath, sharedPath } = payload;
const piHome = "/agent-home/pi";

emit({ type: "runtime_started", runId: run.id, timestamp: nowIso() });

await mkdir(path.join(piHome, "sessions"), { recursive: true });
await mkdir(path.join(workspacePath, "notes"), { recursive: true });

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
const { session } = await createAgentSession({
  cwd: workspacePath,
  sessionManager: SessionManager.inMemory(),
  authStorage,
  modelRegistry,
  model: piConfig.model,
  thinkingLevel: piConfig.thinkingLevel,
  tools: ["read", "bash", "edit", "write", "grep", "find", "ls"],
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

const response = await session.prompt(prompt);
const responseText = typeof response === "string" ? response : JSON.stringify(response);

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

export class DaytonaSandboxProvider implements SandboxProvider {
  readonly name = "daytona" as const;
  private readonly client: DaytonaClientLike;
  private readonly volumeName: string;
  private readonly image: string;
  private readonly snapshot: string | null;
  private readonly createTimeoutSec: number;
  private readonly commandTimeoutSec: number;
  private readonly deleteTimeoutSec: number;
  private readonly agentRuntime: AgentRuntimeConfig;

  constructor(options: DaytonaSandboxProviderOptions = {}) {
    this.client = options.client ?? createDaytonaClient(options);
    this.volumeName = options.volumeName ?? DEFAULT_VOLUME_NAME;
    this.image = options.image ?? DEFAULT_IMAGE;
    this.snapshot = options.snapshot ?? null;
    this.createTimeoutSec = options.createTimeoutSec ?? 120;
    this.commandTimeoutSec = options.commandTimeoutSec ?? 120;
    this.deleteTimeoutSec = options.deleteTimeoutSec ?? 60;
    this.agentRuntime = options.agentRuntime ?? DEFAULT_AGENT_RUNTIME;
  }

  getAgentRuntimeConfig(): AgentRuntimeConfig {
    return this.agentRuntime;
  }

  async startRun(input: StartRunInput): Promise<DaytonaHandle> {
    const volume = await this.client.volume.get(this.volumeName, true);
    const sandbox = await this.client.create(
      {
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
      },
      { timeout: this.createTimeoutSec },
    );

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

  async *exec(input: ExecInput): AsyncIterable<RunEvent> {
    const handle = input.handle as DaytonaHandle;
    if (!handle.sandbox) throw new Error("Daytona handle is missing sandbox instance");

    await this.prepareRemoteRuntime(handle.sandbox, input.payload, handle.localSharedPath);
    const result = await handle.sandbox.process.executeCommand(
      `node ${shellQuote(path.posix.join(REMOTE_HARNESS, "run.mjs"))} ${shellQuote(REMOTE_WAKE)}`,
      REMOTE_WORKSPACE,
      undefined,
      this.commandTimeoutSec,
    );

    const stdout = result.artifacts?.stdout ?? result.result ?? "";
    for (const event of parseJsonlEvents(stdout, input.payload.run.id)) {
      yield event;
    }

    if (result.exitCode !== 0) {
      throw new Error(`Daytona runtime exited with code ${result.exitCode}`);
    }
  }

  async stop(handle: SandboxHandle): Promise<void> {
    const daytonaHandle = handle as DaytonaHandle;
    if (daytonaHandle.sandbox) {
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
    await sandbox.fs.uploadFile(Buffer.from(JSON.stringify(withRemoteRuntimePaths(payload), null, 2), "utf8"), REMOTE_WAKE);

    await this.uploadSharedBundle(sandbox, localSharedPath);
    await this.ensurePersistentFile(sandbox, path.posix.join(REMOTE_AGENT_HOME, "IDENTITY.md"), "# Agent Identity\n\nYou are the default PoC workspace agent.\n");
    await this.ensurePersistentFile(sandbox, path.posix.join(REMOTE_AGENT_HOME, "MEMORY.md"), "# Agent Memory\n\n");
    await this.ensurePersistentFile(sandbox, path.posix.join(REMOTE_AGENT_HOME, "state.json"), '{\n  "version": 1\n}\n');
    await this.ensurePersistentFile(sandbox, path.posix.join(REMOTE_WORKSPACE, "AGENTS.md"), "# Workspace Instructions\n\nThis workspace represents one business or project operated by the agent.\n");
    await this.ensurePersistentFile(sandbox, path.posix.join(REMOTE_WORKSPACE, "TASKS.md"), "# Tasks\n\nCanonical tasks live in the control plane. This file is a local mirror for PoC visibility.\n");
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
