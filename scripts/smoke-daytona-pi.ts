import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { createRunService } from "../apps/control-plane/src/services/run-service.js";
import { JsonStore } from "../apps/control-plane/src/db/store.js";
import { DaytonaSandboxProvider } from "../packages/sandbox/src/daytona-provider.js";
import type { AgentRuntimeConfig } from "../packages/sandbox/src/types.js";

type InspectableHandle = Awaited<ReturnType<DaytonaSandboxProvider["startRun"]>> & {
  sandbox: {
    process: {
      executeCommand(
        command: string,
        cwd?: string,
        env?: Record<string, string>,
        timeout?: number,
      ): Promise<{ exitCode: number; result: string; artifacts?: { stdout?: string } }>;
    };
  };
};

function parseDotEnvValue(raw: string) {
  const trimmed = raw.trim();
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

export async function loadDotEnvFile(filePath = path.resolve(process.cwd(), ".env")) {
  let content: string;
  try {
    content = await readFile(filePath, "utf8");
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return;
    throw error;
  }

  for (const line of content.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const separator = trimmed.indexOf("=");
    if (separator === -1) continue;
    const key = trimmed.slice(0, separator).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;
    if (process.env[key] !== undefined) continue;
    process.env[key] = parseDotEnvValue(trimmed.slice(separator + 1));
  }
}

function requiredEnv(name: string) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function envInt(name: string, fallback: number) {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) throw new Error(`${name} must be a positive integer`);
  return parsed;
}

function requireModelCredentials(model: string) {
  if (model.startsWith("openai/")) requiredEnv("OPENAI_API_KEY");
  if (model.startsWith("anthropic/")) requiredEnv("ANTHROPIC_API_KEY");
}

async function main() {
  await loadDotEnvFile();
  requiredEnv("DAYTONA_API_KEY");
  const model = process.env.PI_MODEL?.trim() || "openai/gpt-5.5";
  requireModelCredentials(model);

  const agentId = process.env.SMOKE_AGENT_ID?.trim() || "agent-smoke-pi";
  const workspaceId = process.env.SMOKE_WORKSPACE_ID?.trim() || `workspace-smoke-pi-${Date.now()}`;
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "poc-daytona-pi-smoke-"));
  const provider = new DaytonaSandboxProvider({
    apiKey: process.env.DAYTONA_API_KEY?.trim(),
    apiUrl: process.env.DAYTONA_API_URL?.trim(),
    target: process.env.DAYTONA_TARGET?.trim(),
    volumeName: process.env.DAYTONA_VOLUME_NAME?.trim() || "poc-ephemeral-agent-sandbox",
    image: process.env.DAYTONA_IMAGE?.trim() || "node:22-bookworm",
    snapshot: process.env.DAYTONA_SNAPSHOT?.trim(),
    createTimeoutSec: envInt("DAYTONA_CREATE_TIMEOUT_SEC", 120),
    commandTimeoutSec: envInt("DAYTONA_COMMAND_TIMEOUT_SEC", 900),
    deleteTimeoutSec: envInt("DAYTONA_DELETE_TIMEOUT_SEC", 60),
    agentRuntime: {
      mode: "pi",
      pi: {
        model,
        thinkingLevel: process.env.PI_THINKING_LEVEL?.trim() || "medium",
      },
    } satisfies AgentRuntimeConfig,
  });

  try {
    const store = await JsonStore.create(path.join(dataDir, "store.json"));
    const service = createRunService({
      repoRoot: process.cwd(),
      dataDir,
      controlPlaneUrl: "http://localhost:3777",
      sharedBundleVersion: process.env.SHARED_BUNDLE_VERSION?.trim() || "v1",
      provider,
      store,
    });

    const first = await service.wake({
      source: "api",
      agentId,
      workspaceId,
      message: "Smoke test 1: create a short durable note and finish.",
    });
    const firstRun = await service.waitForRun(first.runId);
    if (firstRun.status !== "succeeded") throw new Error(`First run failed: ${firstRun.error ?? firstRun.status}`);

    const second = await service.wake({
      source: "api",
      agentId,
      workspaceId,
      message: "Smoke test 2: read the existing workspace state, create another short durable note, and finish.",
    });
    const secondRun = await service.waitForRun(second.runId);
    if (secondRun.status !== "succeeded") throw new Error(`Second run failed: ${secondRun.error ?? secondRun.status}`);

    const inspectHandle = (await provider.startRun({
      runId: `inspect-${Date.now()}`,
      agentId,
      workspaceId,
      agentHomePath: dataDir,
      workspacePath: dataDir,
      sharedPath: dataDir,
      runPath: dataDir,
      wakePath: path.join(dataDir, "wake.json"),
    })) as InspectableHandle;

    try {
      const command = [
        `test -f /workspace/notes/${first.runId}.md`,
        `test -f /workspace/notes/${second.runId}.md`,
        `grep -q ${first.runId} /agent-home/MEMORY.md`,
        `grep -q ${second.runId} /agent-home/MEMORY.md`,
        "test -d /agent-home/pi/sessions",
        "echo daytona-pi-smoke-ok",
      ].join(" && ");
      const result = await inspectHandle.sandbox.process.executeCommand(command, "/workspace", undefined, 120);
      const stdout = result.artifacts?.stdout ?? result.result;
      if (result.exitCode !== 0) throw new Error(`Persistence inspection failed: ${stdout}`);
      process.stdout.write(
        `${JSON.stringify(
          {
            status: "ok",
            agentId,
            workspaceId,
            runs: [first.runId, second.runId],
            inspection: stdout.trim(),
          },
          null,
          2,
        )}\n`,
      );
    } finally {
      await provider.stop(inspectHandle);
    }
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  await main();
}
