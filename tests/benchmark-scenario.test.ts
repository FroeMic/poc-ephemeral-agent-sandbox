import { expect, test } from "vitest";
import {
  benchmarkScenarioSchema,
  benchmarkMatrixSchema,
  readBenchmarkMatrix,
  readBenchmarkScenario,
  scenarioEnv,
  summarizePhaseTimings,
  summarizeScenarioSamples,
} from "../scripts/benchmark-scenario.js";

test("parses a benchmark scenario with conservative defaults", () => {
  expect(
    benchmarkScenarioSchema.parse({
      id: "local-mock",
      provider: "local",
      runtime: "mock",
    }),
  ).toEqual({
    id: "local-mock",
    provider: "local",
    runtime: "mock",
    lifecycle: "create-delete",
    storage: { mode: "ephemeral" },
    warmupTurns: 0,
    measuredTurns: 3,
    cleanupPolicy: "delete",
  });
});

test("maps a baked Blaxel Pi scenario into runtime environment overrides", () => {
  const scenario = benchmarkScenarioSchema.parse({
    id: "blaxel-pi-baked-volume",
    provider: "blaxel",
    runtime: "pi",
    model: "openai/gpt-4o-mini",
    thinkingLevel: "low",
    installDeps: false,
    image: { reference: "sandbox/poc-pi-runner-real-template:latest" },
    storage: { mode: "provider-volume" },
  });

  expect(scenarioEnv(scenario)).toEqual({
    SANDBOX_PROVIDER: "blaxel",
    AGENT_RUNTIME_MODE: "pi",
    PI_MODEL: "openai/gpt-4o-mini",
    PI_THINKING_LEVEL: "low",
    BLAXEL_IMAGE: "sandbox/poc-pi-runner-real-template:latest",
    BLAXEL_PI_INSTALL_DEPS: "false",
  });
});

test("summarizes measured samples separately from warmup samples", () => {
  expect(
    summarizeScenarioSamples([
      { turn: 1, kind: "warmup", runId: "run-warm", status: "succeeded", totalMs: 1000, wakeMs: 800 },
      {
        turn: 1,
        kind: "measured",
        runId: "run-1",
        status: "succeeded",
        totalMs: 300,
        wakeMs: 200,
        phaseTimings: [
          {
            type: "phase_timing",
            runId: "run-1",
            timestamp: "2026-05-20T00:00:00.000Z",
            provider: "local",
            phase: "sandbox_acquire",
            durationMs: 30,
            status: "succeeded",
          },
        ],
      },
      { turn: 2, kind: "measured", runId: "run-2", status: "failed", totalMs: 999, wakeMs: 999, error: "boom" },
      {
        turn: 3,
        kind: "measured",
        runId: "run-3",
        status: "succeeded",
        totalMs: 100,
        wakeMs: 80,
        phaseTimings: [
          {
            type: "phase_timing",
            runId: "run-3",
            timestamp: "2026-05-20T00:00:00.000Z",
            provider: "local",
            phase: "sandbox_acquire",
            durationMs: 10,
            status: "succeeded",
          },
          {
            type: "phase_timing",
            runId: "run-3",
            timestamp: "2026-05-20T00:00:00.000Z",
            provider: "local",
            phase: "runtime_execute",
            durationMs: 80,
            status: "failed",
          },
        ],
      },
    ]),
  ).toEqual({
    warmupCount: 1,
    measuredCount: 3,
    failures: 1,
    totalMs: { min: 100, p50: 100, p90: 300, max: 300 },
    wakeMs: { min: 80, p50: 80, p90: 200, max: 200 },
    phaseTimings: {
      sandbox_acquire: { count: 2, failures: 0, durationMs: { min: 10, p50: 10, p90: 30, max: 30 } },
      runtime_execute: { count: 1, failures: 1, durationMs: { min: 80, p50: 80, p90: 80, max: 80 } },
    },
  });
});

test("summarizes phase timing events by phase", () => {
  expect(
    summarizePhaseTimings([
      {
        type: "phase_timing",
        runId: "run-1",
        timestamp: "2026-05-20T00:00:00.000Z",
        provider: "blaxel",
        phase: "sandbox_acquire",
        durationMs: 3000,
        status: "succeeded",
      },
      {
        type: "phase_timing",
        runId: "run-2",
        timestamp: "2026-05-20T00:00:00.000Z",
        provider: "blaxel",
        phase: "sandbox_acquire",
        durationMs: 5000,
        status: "failed",
      },
    ]),
  ).toEqual({
    sandbox_acquire: {
      count: 2,
      failures: 1,
      durationMs: { min: 3000, p50: 3000, p90: 5000, max: 5000 },
    },
  });
});

test("parses a matrix as ordered scenario references", () => {
  expect(
    benchmarkMatrixSchema.parse({
      id: "provider-smoke",
      scenarios: ["benchmarks/scenarios/local-mock.json", "benchmarks/scenarios/blaxel-pi-baked-volume.json"],
    }),
  ).toEqual({
    id: "provider-smoke",
    scenarios: ["benchmarks/scenarios/local-mock.json", "benchmarks/scenarios/blaxel-pi-baked-volume.json"],
  });
});

test("repository benchmark scenario files are valid", async () => {
  await expect(readBenchmarkScenario("benchmarks/scenarios/local-mock.json")).resolves.toEqual(
    expect.objectContaining({ id: "local-mock" }),
  );
  await expect(readBenchmarkScenario("benchmarks/scenarios/blaxel-pi-baked-volume.json")).resolves.toEqual(
    expect.objectContaining({ id: "blaxel-pi-baked-volume" }),
  );
  await expect(readBenchmarkMatrix("benchmarks/matrix-provider-smoke.json")).resolves.toEqual(
    expect.objectContaining({ id: "provider-smoke" }),
  );
});
