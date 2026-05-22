import { access, cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { spawn } from "node:child_process";
import { loadDotEnvFiles } from "../apps/control-plane/src/config.js";

export type BlaxelPushConfig = {
  sourceDir: string;
  imageName: string;
  timeout: string;
  workspace?: string | undefined;
};

export const DEFAULT_BLAXEL_PI_IMAGE_DIR = "infra/blaxel/pi-sandbox";
export const DEFAULT_BLAXEL_PI_IMAGE_NAME = "poc-pi-runner-real-template";
export const DEFAULT_BLAXEL_PI_IMAGE_TIMEOUT = "30m";

export function blaxelPiImageReference(imageName: string) {
  const lastSegment = imageName.split("/").at(-1) ?? imageName;
  if (lastSegment.includes(":")) return imageName;
  return imageName.includes("/") ? `${imageName}:latest` : `sandbox/${imageName}:latest`;
}

export function buildBlaxelPushArgs(config: BlaxelPushConfig) {
  return [
    "push",
    "--directory",
    config.sourceDir,
    "--type",
    "sandbox",
    "--name",
    config.imageName,
    "--timeout",
    config.timeout,
    ...(config.workspace ? ["--workspace", config.workspace] : []),
    "--yes",
  ];
}

export function upsertDotEnvValues(content: string, updates: Record<string, string>) {
  const remaining = { ...updates };
  const lines = content.split(/\r?\n/);
  const next = lines.map((line) => {
    const match = /^([A-Za-z_][A-Za-z0-9_]*)=.*/.exec(line);
    if (!match) return line;
    const key = match[1];
    const value = remaining[key];
    if (value === undefined) return line;
    delete remaining[key];
    return `${key}=${value}`;
  });

  const insertionIndex = next.at(-1) === "" ? next.length - 1 : next.length;
  next.splice(insertionIndex, 0, ...Object.entries(remaining).map(([key, value]) => `${key}=${value}`));
  return next.join("\n");
}

async function commandExists(command: string) {
  const paths = (process.env.PATH ?? "").split(path.delimiter);
  for (const entry of paths) {
    if (!entry) continue;
    try {
      await access(path.join(entry, command));
      return true;
    } catch {
      // Try the next PATH entry.
    }
  }
  return false;
}

async function runBlaxelPush(args: string[], cwd = process.cwd()) {
  await new Promise<void>((resolve, reject) => {
    const child = spawn("bl", args, { cwd, stdio: "inherit", env: process.env });
    child.on("error", reject);
    child.on("exit", (code) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(new Error(`bl ${args.join(" ")} exited with code ${code ?? "unknown"}`));
    });
  });
}

async function updateDotEnv(imageRef: string) {
  const envPath = path.resolve(process.cwd(), ".env");
  let content = "";
  try {
    content = await readFile(envPath, "utf8");
  } catch (error) {
    if (!error || typeof error !== "object" || !("code" in error) || error.code !== "ENOENT") throw error;
  }

  await writeFile(
    envPath,
    upsertDotEnvValues(content, {
      BLAXEL_IMAGE: imageRef,
      BLAXEL_PI_INSTALL_DEPS: "false",
    }),
    "utf8",
  );
}

export async function main() {
  await loadDotEnvFiles();
  const sourceDir = process.env.BLAXEL_PI_IMAGE_DIR?.trim() || DEFAULT_BLAXEL_PI_IMAGE_DIR;
  const imageName = process.env.BLAXEL_PI_IMAGE_NAME?.trim() || DEFAULT_BLAXEL_PI_IMAGE_NAME;
  const timeout = process.env.BLAXEL_PI_IMAGE_TIMEOUT?.trim() || DEFAULT_BLAXEL_PI_IMAGE_TIMEOUT;
  const workspace = process.env.BL_WORKSPACE?.trim();

  if (!process.env.BL_API_KEY?.trim()) {
    throw new Error("BL_API_KEY is required to push the Blaxel Pi sandbox image.");
  }
  if (!workspace) {
    throw new Error("BL_WORKSPACE is required to push the Blaxel Pi sandbox image.");
  }
  if (!(await commandExists("bl"))) {
    throw new Error("Blaxel CLI `bl` is not installed. Install it with `brew tap blaxel-ai/blaxel && brew install blaxel`.");
  }

  const tempDir = await mkdtemp("/tmp/poc-blaxel-pi-image-");
  const isolatedSourceDir = path.join(tempDir, "pi-sandbox");
  try {
    await cp(path.resolve(sourceDir), isolatedSourceDir, { recursive: true });
    await runBlaxelPush(buildBlaxelPushArgs({ sourceDir: "pi-sandbox", imageName, timeout, workspace }), tempDir);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }

  const imageRef = blaxelPiImageReference(imageName);
  await updateDotEnv(imageRef);
  process.stdout.write(`Updated .env with BLAXEL_IMAGE=${imageRef} and BLAXEL_PI_INSTALL_DEPS=false\n`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  await main();
}
