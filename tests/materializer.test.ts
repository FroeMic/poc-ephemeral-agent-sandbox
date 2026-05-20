import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, test } from "vitest";
import { materializeRunFilesystem } from "../apps/control-plane/src/services/workspace-materializer.js";

const tempDirs: string[] = [];

async function makeTempDir() {
  const dir = await mkdtemp(path.join(os.tmpdir(), "poc-materializer-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

test("materializes agent-home, workspace, shared bundle, and wake payload without overwriting durable files", async () => {
  const root = await makeTempDir();
  const first = await materializeRunFilesystem({
    repoRoot: process.cwd(),
    dataDir: root,
    agentId: "agent-main",
    workspaceId: "workspace-demo",
    runId: "run-1",
    sharedBundleVersion: "v1",
    wakePayload: {
      message: "Create a note",
      runId: "run-1",
    },
  });

  await writeFile(path.join(first.workspacePath, "notes", "existing.md"), "keep me\n", "utf8");

  const second = await materializeRunFilesystem({
    repoRoot: process.cwd(),
    dataDir: root,
    agentId: "agent-main",
    workspaceId: "workspace-demo",
    runId: "run-2",
    sharedBundleVersion: "v1",
    wakePayload: {
      message: "Create another note",
      runId: "run-2",
    },
  });

  await expect(readFile(path.join(second.agentHomePath, "IDENTITY.md"), "utf8")).resolves.toContain(
    "default PoC workspace agent",
  );
  await expect(readFile(path.join(second.workspacePath, "AGENTS.md"), "utf8")).resolves.toContain(
    "business or project",
  );
  await expect(readFile(path.join(second.workspacePath, "notes", "existing.md"), "utf8")).resolves.toBe("keep me\n");
  await expect(readFile(path.join(second.sharedPath, "manifest.json"), "utf8")).resolves.toContain('"version": "v1"');
  await expect(readFile(path.join(second.runPath, "wake.json"), "utf8")).resolves.toContain("Create another note");
});
