import { expect, test } from "vitest";
import { summarizeBenchmarkSamples } from "../scripts/benchmark-chat-turn.js";

test("summarizes benchmark samples with stable percentiles", () => {
  expect(
    summarizeBenchmarkSamples([
      { totalMs: 300, wakeMs: 100, runId: "run-3", status: "succeeded" },
      { totalMs: 100, wakeMs: 40, runId: "run-1", status: "succeeded" },
      { totalMs: 200, wakeMs: 80, runId: "run-2", status: "succeeded" },
    ]),
  ).toEqual({
    count: 3,
    totalMs: { min: 100, p50: 200, p90: 300, max: 300 },
    wakeMs: { min: 40, p50: 80, p90: 100, max: 100 },
    failures: 0,
  });
});
