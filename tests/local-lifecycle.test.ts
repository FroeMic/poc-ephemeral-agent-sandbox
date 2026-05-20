import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, test } from "vitest";
import { createRunService } from "../apps/control-plane/src/services/run-service.js";
import { JsonStore } from "../apps/control-plane/src/db/store.js";
import { LocalSandboxProvider } from "../packages/sandbox/src/local-provider.js";

const tempDirs: string[] = [];

async function makeTempDir() {
  const dir = await mkdtemp(path.join(os.tmpdir(), "poc-lifecycle-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

test("runs the local sandbox lifecycle and preserves workspace state across runs", async () => {
  const dataDir = await makeTempDir();
  const store = await JsonStore.create(path.join(dataDir, "store.json"));
  const service = createRunService({
    repoRoot: process.cwd(),
    dataDir,
    controlPlaneUrl: "http://127.0.0.1:3000",
    sharedBundleVersion: "v1",
    provider: new LocalSandboxProvider({ repoRoot: process.cwd() }),
    store,
  });

  const first = await service.wake({
    source: "api",
    agentId: "agent-main",
    workspaceId: "workspace-demo",
    message: "Create the first durable note",
  });
  await service.waitForRun(first.runId);

  const second = await service.wake({
    source: "api",
    agentId: "agent-main",
    workspaceId: "workspace-demo",
    message: "Create the second durable note",
  });
  const completed = await service.waitForRun(second.runId);

  expect(completed.status).toBe("succeeded");
  const workspacePath = path.join(dataDir, "workspaces", "workspace-demo");
  await expect(readFile(path.join(workspacePath, "notes", `${first.runId}.md`), "utf8")).resolves.toContain(
    "Create the first durable note",
  );
  await expect(readFile(path.join(workspacePath, "notes", `${second.runId}.md`), "utf8")).resolves.toContain(
    "Create the second durable note",
  );

  const events = store.listRunEvents(second.runId);
  expect(events.map((event) => event.type)).toContain("sandbox_started");
  expect(events.map((event) => event.type)).toContain("run_finished");
});
