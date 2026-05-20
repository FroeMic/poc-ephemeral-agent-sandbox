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

export async function loadDotEnvFiles(dir = process.cwd()) {
  await loadDotEnvFile(path.resolve(dir, ".env.local"));
  await loadDotEnvFile(path.resolve(dir, ".env"));
}

export function assertDaytonaCredentials() {
  const apiKey = process.env.DAYTONA_API_KEY?.trim();
  const jwtToken = process.env.DAYTONA_JWT_TOKEN?.trim();
  const organizationId = process.env.DAYTONA_ORGANIZATION_ID?.trim();
  if (apiKey || (jwtToken && organizationId)) return;
  throw new Error("DAYTONA_API_KEY or DAYTONA_JWT_TOKEN plus DAYTONA_ORGANIZATION_ID is required");
}

export function getSmokePreflightStatus() {
  const model = process.env.PI_MODEL?.trim() || "openai/gpt-5.5";
  const apiKey = process.env.DAYTONA_API_KEY?.trim();
  const jwtToken = process.env.DAYTONA_JWT_TOKEN?.trim();
  const organizationId = process.env.DAYTONA_ORGANIZATION_ID?.trim();
  const missing: string[] = [];

  if (!apiKey && !(jwtToken && organizationId)) {
    missing.push("DAYTONA_API_KEY or DAYTONA_JWT_TOKEN plus DAYTONA_ORGANIZATION_ID");
  }
  if (model.startsWith("openai/") && !process.env.OPENAI_API_KEY?.trim()) {
    missing.push("OPENAI_API_KEY");
  }
  if (model.startsWith("anthropic/") && !process.env.ANTHROPIC_API_KEY?.trim()) {
    missing.push("ANTHROPIC_API_KEY");
  }

  return {
    ok: missing.length === 0,
    model,
    missing,
  };
}

type SmokePreflightStatus = ReturnType<typeof getSmokePreflightStatus>;

export function formatSmokePreflightFailure(preflight: SmokePreflightStatus) {
  return [
    "Daytona/Pi smoke preflight failed.",
    `Model: ${preflight.model}`,
    "Missing:",
    ...preflight.missing.map((item) => `- ${item}`),
  ].join("\n");
}

function sanitizeSmokeErrorMessage(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  if (/access denied/i.test(message)) return "Access denied";
  if (/unauthorized/i.test(message)) return "Unauthorized";
  if (/authentication/i.test(message)) return "Authentication failed";
  return message.replace(/(?:dtn|sk|sk-proj)_[A-Za-z0-9_-]+/g, "[redacted]");
}

export function getSmokeRuntimePreflightFailure(error: unknown) {
  return [
    "Daytona/Pi smoke runtime preflight failed.",
    `Daytona access check failed: ${sanitizeSmokeErrorMessage(error)}`,
    "Check that DAYTONA_API_KEY has write:sandboxes, delete:sandboxes, read:volumes, and write:volumes scopes.",
  ].join("\n");
}

function envInt(name: string, fallback: number) {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) throw new Error(`${name} must be a positive integer`);
  return parsed;
}

function runFailureDetails(store: JsonStore, runId: string) {
  const events = store.listRunEvents(runId);
  const recentEvents = events.slice(-20);
  return JSON.stringify({ runId, recentEvents }, null, 2);
}

async function main() {
  await loadDotEnvFiles();
  const preflight = getSmokePreflightStatus();
  if (!preflight.ok) {
    process.stderr.write(`${formatSmokePreflightFailure(preflight)}\n`);
    process.exitCode = 1;
    return;
  }
  const model = preflight.model;

  const agentId = process.env.SMOKE_AGENT_ID?.trim() || "agent-smoke-pi";
  const workspaceId = process.env.SMOKE_WORKSPACE_ID?.trim() || `workspace-smoke-pi-${Date.now()}`;
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "poc-daytona-pi-smoke-"));
  const provider = new DaytonaSandboxProvider({
    apiKey: process.env.DAYTONA_API_KEY?.trim(),
    jwtToken: process.env.DAYTONA_JWT_TOKEN?.trim(),
    organizationId: process.env.DAYTONA_ORGANIZATION_ID?.trim(),
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
    try {
      await provider.startRun({
        runId: `preflight-${Date.now()}`,
        agentId,
        workspaceId,
        agentHomePath: dataDir,
        workspacePath: dataDir,
        sharedPath: dataDir,
        runPath: dataDir,
        wakePath: path.join(dataDir, "wake.json"),
      }).then((handle) => provider.stop(handle));
    } catch (error) {
      process.stderr.write(`${getSmokeRuntimePreflightFailure(error)}\n`);
      process.exitCode = 1;
      return;
    }

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
    if (firstRun.status !== "succeeded") {
      throw new Error(`First run failed: ${firstRun.error ?? firstRun.status}\n${runFailureDetails(store, first.runId)}`);
    }

    const second = await service.wake({
      source: "api",
      agentId,
      workspaceId,
      message: "Smoke test 2: read the existing workspace state, create another short durable note, and finish.",
    });
    const secondRun = await service.waitForRun(second.runId);
    if (secondRun.status !== "succeeded") {
      throw new Error(`Second run failed: ${secondRun.error ?? secondRun.status}\n${runFailureDetails(store, second.runId)}`);
    }

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
