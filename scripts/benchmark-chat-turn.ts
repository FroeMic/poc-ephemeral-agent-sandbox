import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { readConfig } from "../apps/control-plane/src/config.js";
import { JsonStore } from "../apps/control-plane/src/db/store.js";
import { createSandboxProvider } from "../apps/control-plane/src/provider.js";
import { createRunService } from "../apps/control-plane/src/services/run-service.js";
import { loadDotEnvFiles } from "./smoke-daytona-pi.js";
import type { AgentRuntimeConfig, SandboxProvider } from "../packages/sandbox/src/types.js";

export type BenchmarkSample = {
  runId: string;
  status: string;
  totalMs: number;
  wakeMs: number;
  error?: string;
};

type PercentileSummary = {
  min: number;
  p50: number;
  p90: number;
  max: number;
};

function percentile(sorted: number[], ratio: number) {
  if (sorted.length === 0) return 0;
  const index = Math.ceil(sorted.length * ratio) - 1;
  return sorted[Math.max(0, Math.min(sorted.length - 1, index))] ?? 0;
}

function summarize(values: number[]): PercentileSummary {
  const sorted = [...values].sort((a, b) => a - b);
  return {
    min: sorted[0] ?? 0,
    p50: percentile(sorted, 0.5),
    p90: percentile(sorted, 0.9),
    max: sorted.at(-1) ?? 0,
  };
}

export function summarizeBenchmarkSamples(samples: BenchmarkSample[]) {
  const succeeded = samples.filter((sample) => sample.status === "succeeded");
  return {
    count: samples.length,
    totalMs: summarize(succeeded.map((sample) => sample.totalMs)),
    wakeMs: summarize(succeeded.map((sample) => sample.wakeMs)),
    failures: samples.length - succeeded.length,
  };
}

function envInt(name: string, fallback: number) {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) throw new Error(`${name} must be a positive integer`);
  return parsed;
}

function providerAgentRuntime(provider: SandboxProvider, fallback: AgentRuntimeConfig) {
  if ("getAgentRuntimeConfig" in provider && typeof provider.getAgentRuntimeConfig === "function") {
    return provider.getAgentRuntimeConfig();
  }
  return fallback;
}

async function main() {
  await loadDotEnvFiles();
  const config = readConfig();
  const turns = envInt("BENCH_TURNS", 3);
  const message = process.env.BENCH_MESSAGE?.trim() || "Say hi, remember this turn, and reply in one short sentence.";
  const agentId = process.env.BENCH_AGENT_ID?.trim() || `bench-${config.sandboxProvider}-agent`;
  const workspaceId = process.env.BENCH_WORKSPACE_ID?.trim() || `bench-${config.sandboxProvider}-workspace-${Date.now()}`;
  const dataDir = await mkdtemp(path.join(os.tmpdir(), `poc-${config.sandboxProvider}-bench-`));

  try {
    const store = await JsonStore.create(path.join(dataDir, "store.json"));
    const provider = createSandboxProvider({ ...config, dataDir });
    const service = createRunService({
      repoRoot: config.repoRoot,
      dataDir,
      controlPlaneUrl: config.controlPlaneUrl,
      sharedBundleVersion: config.sharedBundleVersion,
      provider,
      store,
    });

    const samples: BenchmarkSample[] = [];
    for (let turn = 1; turn <= turns; turn += 1) {
      const started = performance.now();
      const response = await service.chatTurn({
        source: "chat",
        agentId,
        workspaceId,
        message: `${message}\n\nBenchmark turn ${turn} of ${turns}.`,
      });
      const totalMs = Math.round(performance.now() - started);
      const wakeEvent = response.events.find((event) => event.type === "wake_received");
      const runtimeEvent = response.events.find((event) => event.type === "runtime_started");
      const wakeMs =
        wakeEvent && runtimeEvent
          ? Math.max(0, Date.parse(runtimeEvent.timestamp) - Date.parse(wakeEvent.timestamp))
          : totalMs;
      samples.push({
        runId: response.run.id,
        status: response.run.status,
        totalMs,
        wakeMs,
        ...(response.run.error ? { error: response.run.error } : {}),
      });
      process.stdout.write(
        `${JSON.stringify({ provider: provider.name, turn, runId: response.run.id, status: response.run.status, totalMs, wakeMs })}\n`,
      );
    }

    process.stdout.write(
      `${JSON.stringify(
        {
          provider: provider.name,
          agentRuntime: providerAgentRuntime(provider, config.agentRuntime),
          agentId,
          workspaceId,
          summary: summarizeBenchmarkSamples(samples),
          samples,
        },
        null,
        2,
      )}\n`,
    );
  } finally {
    if (process.env.BENCH_KEEP_DATA !== "true") {
      await rm(dataDir, { recursive: true, force: true });
    }
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  await main();
}
