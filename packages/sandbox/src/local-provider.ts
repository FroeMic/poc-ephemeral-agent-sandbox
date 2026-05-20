import type { RunEvent } from "@poc/shared";
import { nowIso } from "@poc/shared";
import { runRuntime } from "../../agentruntime/src/index.js";
import type { ExecInput, SandboxHandle, SandboxProvider, StartRunInput } from "./types.js";

async function* runInProcess(input: ExecInput): AsyncIterable<RunEvent> {
  const queue: RunEvent[] = [];
  let exitError: Error | null = null;
  let done = false;
  let pendingNotify: (() => void) | null = null;

  const notify = () => {
    pendingNotify?.();
    pendingNotify = null;
  };

  void runRuntime(input.payload, (event) => {
    queue.push(event);
    notify();
  })
    .catch((error: unknown) => {
      exitError = error instanceof Error ? error : new Error(String(error));
      queue.push({
        type: "run_finished",
        runId: input.payload.run.id,
        timestamp: nowIso(),
        status: "failed",
        error: exitError.message,
      });
    })
    .finally(() => {
      done = true;
      notify();
    });

  while (!done || queue.length > 0) {
    const next = queue.shift();
    if (next) {
      yield next;
      continue;
    }
    await new Promise<void>((resolve) => {
      pendingNotify = resolve;
    });
  }

  if (exitError) throw exitError;
}

export class LocalSandboxProvider implements SandboxProvider {
  readonly name = "local" as const;

  constructor(_options: { repoRoot: string }) {}

  async startRun(input: StartRunInput): Promise<SandboxHandle> {
    return {
      provider: this.name,
      sandboxId: `local-${input.runId}`,
    };
  }

  exec(input: ExecInput): AsyncIterable<RunEvent> {
    return runInProcess(input);
  }

  async stop(_handle: SandboxHandle): Promise<void> {
    return;
  }
}
