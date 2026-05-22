import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { z } from "zod";
import { readConfig, loadDotEnvFiles } from "../apps/control-plane/src/config.js";
import { JsonStore } from "../apps/control-plane/src/db/store.js";
import { createSandboxProvider } from "../apps/control-plane/src/provider.js";
import { createRunService } from "../apps/control-plane/src/services/run-service.js";
import type { BenchmarkSample } from "./benchmark-chat-turn.js";
import type { RunEvent } from "../packages/shared/src/index.js";

const execFileAsync = promisify(execFile);

const providerSchema = z.enum(["local", "daytona", "e2b", "blaxel"]);
const runtimeSchema = z.enum(["mock", "pi"]);

export const benchmarkScenarioSchema = z.object({
  id: z.string().min(1).regex(/^[A-Za-z0-9._-]+$/),
  description: z.string().optional(),
  provider: providerSchema,
  runtime: runtimeSchema,
  model: z.string().min(1).optional(),
  thinkingLevel: z.string().min(1).optional(),
  installDeps: z.boolean().optional(),
  lifecycle: z.string().min(1).default("create-delete"),
  storage: z
    .object({
      mode: z.string().min(1).default("ephemeral"),
      mountPath: z.string().optional(),
    })
    .default({ mode: "ephemeral" }),
  image: z
    .object({
      reference: z.string().min(1).optional(),
      template: z.string().min(1).optional(),
      snapshot: z.string().min(1).optional(),
      prebuild: z.array(z.string().min(1)).optional(),
    })
    .optional(),
  workload: z
    .object({
      sharedBundle: z.string().min(1).optional(),
      conversationShape: z.string().min(1).optional(),
      message: z.string().min(1).optional(),
    })
    .optional(),
  agentId: z.string().min(1).optional(),
  workspaceId: z.string().min(1).optional(),
  warmupTurns: z.number().int().min(0).default(0),
  measuredTurns: z.number().int().min(1).default(3),
  cleanupPolicy: z.enum(["delete", "pause", "keep"]).default("delete"),
  env: z.record(z.string()).optional(),
  metadata: z.record(z.unknown()).optional(),
});
export type BenchmarkScenario = z.infer<typeof benchmarkScenarioSchema>;

export const benchmarkMatrixSchema = z.object({
  id: z.string().min(1).regex(/^[A-Za-z0-9._-]+$/),
  description: z.string().optional(),
  scenarios: z.array(z.string().min(1)).min(1),
});
export type BenchmarkMatrix = z.infer<typeof benchmarkMatrixSchema>;

export type ScenarioSample = BenchmarkSample & {
  turn: number;
  kind: "warmup" | "measured";
  assistantMessage?: string;
  phaseTimings?: Extract<RunEvent, { type: "phase_timing" }>[];
};

export type BenchmarkScenarioResult = {
  scenario: BenchmarkScenario;
  metadata: {
    startedAt: string;
    finishedAt: string;
    gitCommit?: string;
    nodeVersion: string;
    platform: string;
    env: Record<string, string>;
  };
  samples: ScenarioSample[];
  summary: ReturnType<typeof summarizeScenarioSamples>;
};

function boolEnv(value: boolean) {
  return value ? "true" : "false";
}

export function scenarioEnv(scenario: BenchmarkScenario) {
  const env: Record<string, string> = {
    SANDBOX_PROVIDER: scenario.provider,
    AGENT_RUNTIME_MODE: scenario.runtime,
  };

  if (scenario.model) env.PI_MODEL = scenario.model;
  if (scenario.thinkingLevel) env.PI_THINKING_LEVEL = scenario.thinkingLevel;
  if (scenario.installDeps !== undefined) {
    if (scenario.provider === "blaxel") env.BLAXEL_PI_INSTALL_DEPS = boolEnv(scenario.installDeps);
    else env.PI_INSTALL_DEPS = boolEnv(scenario.installDeps);
  }

  if (scenario.image?.reference) {
    if (scenario.provider === "blaxel") env.BLAXEL_IMAGE = scenario.image.reference;
    if (scenario.provider === "daytona") env.DAYTONA_IMAGE = scenario.image.reference;
  }
  if (scenario.image?.template && scenario.provider === "e2b") env.E2B_TEMPLATE = scenario.image.template;
  if (scenario.image?.snapshot && scenario.provider === "daytona") env.DAYTONA_SNAPSHOT = scenario.image.snapshot;

  if (scenario.provider === "e2b") {
    env.E2B_STORAGE_MODE = scenario.storage.mode;
    if (scenario.storage.mode === "provider-volume") env.E2B_USE_VOLUMES = "true";
    if (scenario.storage.mode === "archil" || scenario.storage.mode === "ephemeral") env.E2B_USE_VOLUMES = "false";
  }

  return {
    ...env,
    ...(scenario.env ?? {}),
  };
}

function percentile(sorted: number[], ratio: number) {
  if (sorted.length === 0) return 0;
  const index = Math.ceil(sorted.length * ratio) - 1;
  return sorted[Math.max(0, Math.min(sorted.length - 1, index))] ?? 0;
}

function summarize(values: number[]) {
  const sorted = [...values].sort((a, b) => a - b);
  return {
    min: sorted[0] ?? 0,
    p50: percentile(sorted, 0.5),
    p90: percentile(sorted, 0.9),
    max: sorted.at(-1) ?? 0,
  };
}

export function summarizePhaseTimings(timings: Extract<RunEvent, { type: "phase_timing" }>[]) {
  const byPhase: Record<
    string,
    {
      count: number;
      failures: number;
      durationMs: ReturnType<typeof summarize>;
    }
  > = {};

  const phases = [...new Set(timings.map((timing) => timing.phase))].sort();
  for (const phase of phases) {
    const samples = timings.filter((timing) => timing.phase === phase);
    byPhase[phase] = {
      count: samples.length,
      failures: samples.filter((timing) => timing.status === "failed").length,
      durationMs: summarize(samples.map((timing) => timing.durationMs)),
    };
  }
  return byPhase;
}

export function summarizeScenarioSamples(samples: ScenarioSample[]) {
  const measured = samples.filter((sample) => sample.kind === "measured");
  const succeeded = measured.filter((sample) => sample.status === "succeeded");
  return {
    warmupCount: samples.filter((sample) => sample.kind === "warmup").length,
    measuredCount: measured.length,
    failures: measured.length - succeeded.length,
    totalMs: summarize(succeeded.map((sample) => sample.totalMs)),
    wakeMs: summarize(succeeded.map((sample) => sample.wakeMs)),
    phaseTimings: summarizePhaseTimings(measured.flatMap((sample) => sample.phaseTimings ?? [])),
  };
}

async function readJsonFile(filePath: string) {
  return JSON.parse(await readFile(filePath, "utf8")) as unknown;
}

export async function readBenchmarkScenario(filePath: string) {
  return benchmarkScenarioSchema.parse(await readJsonFile(filePath));
}

export async function readBenchmarkMatrix(filePath: string) {
  return benchmarkMatrixSchema.parse(await readJsonFile(filePath));
}

async function gitCommit() {
  try {
    const { stdout } = await execFileAsync("git", ["rev-parse", "--short", "HEAD"]);
    return stdout.trim();
  } catch {
    return undefined;
  }
}

function resultFileName(scenario: BenchmarkScenario, startedAt: string) {
  return `${startedAt.replace(/[:.]/g, "-")}-${scenario.id}.json`;
}

export async function runBenchmarkScenario(
  scenario: BenchmarkScenario,
  options: {
    resultsDir?: string;
    keepData?: boolean;
  } = {},
): Promise<{ result: BenchmarkScenarioResult; resultPath?: string }> {
  await loadDotEnvFiles();
  const overrides = scenarioEnv(scenario);
  const previousEnv = new Map(Object.keys(overrides).map((key) => [key, process.env[key]] as const));
  for (const [key, value] of Object.entries(overrides)) process.env[key] = value;

  const startedAt = new Date().toISOString();
  const dataDir = await mkdirTempDataDir(scenario);
  try {
    const config = readConfig();
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

    const agentId = scenario.agentId ?? `bench-${scenario.id}-agent`;
    const workspaceId = scenario.workspaceId ?? `bench-${scenario.id}-workspace`;
    const message = scenario.workload?.message ?? "Say hi, remember this turn, and reply in one short sentence.";
    const samples: ScenarioSample[] = [];

    for (let turn = 1; turn <= scenario.warmupTurns + scenario.measuredTurns; turn += 1) {
      const kind = turn <= scenario.warmupTurns ? "warmup" : "measured";
      const measuredTurn = kind === "warmup" ? turn : turn - scenario.warmupTurns;
      const started = performance.now();
      const response = await service.chatTurn({
        source: "chat",
        agentId,
        workspaceId,
        sandboxProvider: scenario.provider,
        message: `${message}\n\nScenario ${scenario.id}; ${kind} turn ${measuredTurn}.`,
      });
      const totalMs = Math.round(performance.now() - started);
      const wakeEvent = response.events.find((event) => event.type === "wake_received");
      const runtimeEvent = response.events.find((event) => event.type === "runtime_started");
      const wakeMs =
        wakeEvent && runtimeEvent ? Math.max(0, Date.parse(runtimeEvent.timestamp) - Date.parse(wakeEvent.timestamp)) : totalMs;

      const sample: ScenarioSample = {
        kind,
        turn: measuredTurn,
        runId: response.run.id,
        status: response.run.status,
        totalMs,
        wakeMs,
        phaseTimings: response.events.filter((event): event is Extract<RunEvent, { type: "phase_timing" }> => event.type === "phase_timing"),
        assistantMessage: response.assistantMessage,
        ...(response.run.error ? { error: response.run.error } : {}),
      };
      samples.push(sample);
      process.stdout.write(`${JSON.stringify({ scenario: scenario.id, provider: provider.name, kind, turn: measuredTurn, ...sample })}\n`);
    }

    const finishedAt = new Date().toISOString();
    const result: BenchmarkScenarioResult = {
      scenario,
      metadata: {
        startedAt,
        finishedAt,
        gitCommit: await gitCommit(),
        nodeVersion: process.version,
        platform: `${process.platform}-${process.arch}`,
        env: overrides,
      },
      samples,
      summary: summarizeScenarioSamples(samples),
    };

    let resultPath: string | undefined;
    if (options.resultsDir) {
      await mkdir(options.resultsDir, { recursive: true });
      resultPath = path.join(options.resultsDir, resultFileName(scenario, startedAt));
      await writeFile(resultPath, `${JSON.stringify(result, null, 2)}\n`, "utf8");
    }
    return { result, resultPath };
  } finally {
    for (const [key, value] of previousEnv) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    if (!options.keepData && scenario.cleanupPolicy !== "keep") {
      await rm(dataDir, { recursive: true, force: true });
    }
  }
}

async function mkdirTempDataDir(scenario: BenchmarkScenario) {
  return mkdtemp(path.join(os.tmpdir(), `poc-bench-${scenario.id}-`));
}

export async function runBenchmarkMatrix(
  matrix: BenchmarkMatrix,
  options: {
    baseDir?: string;
    resultsDir?: string;
    keepData?: boolean;
  } = {},
) {
  const baseDir = options.baseDir ?? process.cwd();
  const results = [];
  for (const scenarioPath of matrix.scenarios) {
    const scenario = await readBenchmarkScenario(path.resolve(baseDir, scenarioPath));
    results.push(await runBenchmarkScenario(scenario, { resultsDir: options.resultsDir, keepData: options.keepData }));
  }
  return results;
}

async function main() {
  const [modeOrPath, maybePath] = process.argv.slice(2);
  if (!modeOrPath) {
    throw new Error("Usage: pnpm bench:scenario <scenario.json> or pnpm bench:matrix <matrix.json>");
  }

  const isMatrix = modeOrPath === "--matrix";
  const inputPath = path.resolve(isMatrix ? maybePath ?? "" : modeOrPath);
  const resultsDir = path.resolve(process.env.BENCH_RESULTS_DIR ?? "benchmarks/results");
  const keepData = process.env.BENCH_KEEP_DATA === "true";

  if (isMatrix) {
    const matrix = await readBenchmarkMatrix(inputPath);
    const results = await runBenchmarkMatrix(matrix, { baseDir: process.cwd(), resultsDir, keepData });
    process.stdout.write(`${JSON.stringify({ matrix: matrix.id, resultPaths: results.map((entry) => entry.resultPath) }, null, 2)}\n`);
    return;
  }

  const scenario = await readBenchmarkScenario(inputPath);
  const { result, resultPath } = await runBenchmarkScenario(scenario, { resultsDir, keepData });
  process.stdout.write(`${JSON.stringify({ scenario: scenario.id, resultPath, summary: result.summary }, null, 2)}\n`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  await main();
}
