import { cp, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

export type MaterializedRunFilesystem = {
  agentHomePath: string;
  workspacePath: string;
  sharedPath: string;
  runPath: string;
  wakePath: string;
};

async function copyTemplateIfMissing(source: string, target: string) {
  await mkdir(path.dirname(target), { recursive: true });
  await cp(source, target, {
    recursive: true,
    force: false,
    errorOnExist: false,
  });
}

export async function materializeRunFilesystem(input: {
  repoRoot: string;
  dataDir: string;
  agentId: string;
  workspaceId: string;
  runId: string;
  sharedBundleVersion: string;
  wakePayload: unknown;
}): Promise<MaterializedRunFilesystem> {
  const agentHomePath = path.join(input.dataDir, "agents", input.agentId);
  const workspacePath = path.join(input.dataDir, "workspaces", input.workspaceId);
  const runPath = path.join(input.dataDir, "runs", input.runId);
  const sharedPath = path.join(runPath, "agentruntime", "shared");
  const wakePath = path.join(runPath, "wake.json");

  await copyTemplateIfMissing(path.join(input.repoRoot, "templates", "agent-home"), agentHomePath);
  await copyTemplateIfMissing(path.join(input.repoRoot, "templates", "workspace"), workspacePath);
  await mkdir(path.dirname(sharedPath), { recursive: true });
  await cp(path.join(input.repoRoot, "runtime", "shared", input.sharedBundleVersion), sharedPath, {
    recursive: true,
    force: true,
  });
  await mkdir(runPath, { recursive: true });
  await writeFile(wakePath, `${JSON.stringify(input.wakePayload, null, 2)}\n`, "utf8");

  return {
    agentHomePath,
    workspacePath,
    sharedPath,
    runPath,
    wakePath,
  };
}
