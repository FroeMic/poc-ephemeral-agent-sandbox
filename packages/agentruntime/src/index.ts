import { appendFile, mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { nowIso, runtimeWakePayloadSchema, type RunEvent, type RuntimeWakePayload } from "@poc/shared";

function emitStdout(event: RunEvent) {
  process.stdout.write(`${JSON.stringify(event)}\n`);
}

function requireWakePayload() {
  const raw = process.env.AGENTRUNTIME_WAKE_JSON;
  if (!raw) throw new Error("AGENTRUNTIME_WAKE_JSON is required");
  return runtimeWakePayloadSchema.parse(JSON.parse(raw));
}

export async function runRuntime(payload: RuntimeWakePayload, emit: (event: RunEvent) => void | Promise<void>) {
  const { run, wakeEvent, agentHomePath, workspacePath, sharedPath } = payload;

  await emit({ type: "runtime_started", runId: run.id, timestamp: nowIso() });

  const identity = await readFile(path.join(agentHomePath, "IDENTITY.md"), "utf8");
  const workspaceInstructions = await readFile(path.join(workspacePath, "AGENTS.md"), "utf8");
  const sharedEntries = await readdir(sharedPath);

  await emit({
    type: "stdout",
    runId: run.id,
    timestamp: nowIso(),
    data: `Loaded identity (${identity.length} chars), workspace instructions (${workspaceInstructions.length} chars), shared entries: ${sharedEntries.join(", ")}`,
  });

  const assistantMessage = `Handled your message for ${run.agentId}: ${wakeEvent.message}`;
  await emit({
    type: "assistant_message",
    runId: run.id,
    timestamp: nowIso(),
    content: assistantMessage,
  });

  await appendFile(
    path.join(agentHomePath, "MEMORY.md"),
    `\n## ${nowIso()} ${run.id}\n\nHandled wake: ${wakeEvent.message}\n`,
    "utf8",
  );
  await emit({
    type: "file_changed",
    runId: run.id,
    timestamp: nowIso(),
    path: path.join(agentHomePath, "MEMORY.md"),
  });

  const notesDir = path.join(workspacePath, "notes");
  await mkdir(notesDir, { recursive: true });
  const notePath = path.join(notesDir, `${run.id}.md`);
  await writeFile(
    notePath,
    [
      `# Run ${run.id}`,
      "",
      `Message: ${wakeEvent.message}`,
      `Agent: ${run.agentId}`,
      `Workspace: ${run.workspaceId}`,
      `Shared bundle: ${run.sharedBundleVersion}`,
      "",
    ].join("\n"),
    "utf8",
  );
  await emit({ type: "file_changed", runId: run.id, timestamp: nowIso(), path: notePath });
  await emit({ type: "artifact_created", runId: run.id, timestamp: nowIso(), path: notePath });

  if (run.taskId) {
    await emit({ type: "task_updated", runId: run.id, timestamp: nowIso(), taskId: run.taskId, status: "done" });
  }

  await emit({ type: "run_finished", runId: run.id, timestamp: nowIso(), status: "succeeded" });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  runRuntime(requireWakePayload(), emitStdout).catch((error: unknown) => {
    const runId = (() => {
      try {
        return requireWakePayload().run.id;
      } catch {
        return "unknown";
      }
    })();
    emitStdout({
      type: "run_finished",
      runId,
      timestamp: nowIso(),
      status: "failed",
      error: error instanceof Error ? error.message : String(error),
    });
    process.exitCode = 1;
  });
}
