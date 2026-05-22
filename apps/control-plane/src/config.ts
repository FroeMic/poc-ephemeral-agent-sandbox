import { readFile } from "node:fs/promises";
import path from "node:path";
import type { AgentRuntimeMode } from "@poc/sandbox";

function parseDotEnvValue(raw: string) {
  const trimmed = raw.trim();
  if ((trimmed.startsWith('"') && trimmed.endsWith('"')) || (trimmed.startsWith("'") && trimmed.endsWith("'"))) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

export async function loadDotEnvFile(filePath: string) {
  let content: string;
  try {
    content = await readFile(filePath, "utf8");
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return;
    throw error;
  }

  for (const line of content.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const separator = trimmed.indexOf("=");
    if (separator === -1) continue;
    const key = trimmed.slice(0, separator).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;
    if (process.env[key] !== undefined) continue;
    process.env[key] = parseDotEnvValue(trimmed.slice(separator + 1));
  }
}

export async function loadDotEnvFiles(dir = process.cwd()) {
  await loadDotEnvFile(path.resolve(dir, ".env.local"));
  await loadDotEnvFile(path.resolve(dir, ".env"));
}

function env(name: string, fallback: string) {
  const value = process.env[name]?.trim();
  return value && value.length > 0 ? value : fallback;
}

function envInt(name: string, fallback: number) {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`Unsupported ${name}: ${raw}`);
  }
  return parsed;
}

function envBool(name: string, fallback: boolean) {
  const raw = process.env[name]?.trim().toLowerCase();
  if (!raw) return fallback;
  if (["1", "true", "yes", "on"].includes(raw)) return true;
  if (["0", "false", "no", "off"].includes(raw)) return false;
  throw new Error(`Unsupported ${name}: ${process.env[name]}`);
}

function envBoolOptional(name: string): boolean | undefined {
  const raw = process.env[name]?.trim().toLowerCase();
  if (!raw) return undefined;
  if (["1", "true", "yes", "on"].includes(raw)) return true;
  if (["0", "false", "no", "off"].includes(raw)) return false;
  throw new Error(`Unsupported ${name}: ${process.env[name]}`);
}

export function readConfig() {
  const repoRoot = process.cwd();
  const rawAgentRuntimeMode = env("AGENT_RUNTIME_MODE", "mock");
  if (rawAgentRuntimeMode !== "mock" && rawAgentRuntimeMode !== "pi") {
    throw new Error(`Unsupported AGENT_RUNTIME_MODE: ${rawAgentRuntimeMode}`);
  }
  const agentRuntimeMode: AgentRuntimeMode = rawAgentRuntimeMode;
  return {
    repoRoot,
    port: Number.parseInt(env("PORT", "3000"), 10),
    controlPlaneUrl: env("CONTROL_PLANE_URL", "http://localhost:3000"),
    dataDir: path.resolve(repoRoot, env("DATA_DIR", "./data")),
    sharedBundleVersion: env("SHARED_BUNDLE_VERSION", "v1"),
    sandboxProvider: env("SANDBOX_PROVIDER", "local"),
    agentRuntime: {
      mode: agentRuntimeMode,
      pi: {
        model: env("PI_MODEL", "openai/gpt-5.5"),
        thinkingLevel: env("PI_THINKING_LEVEL", "medium"),
        installDeps: envBool("PI_INSTALL_DEPS", true),
      },
    },
    daytona: {
      apiKey: process.env.DAYTONA_API_KEY?.trim(),
      jwtToken: process.env.DAYTONA_JWT_TOKEN?.trim(),
      organizationId: process.env.DAYTONA_ORGANIZATION_ID?.trim(),
      apiUrl: process.env.DAYTONA_API_URL?.trim(),
      target: process.env.DAYTONA_TARGET?.trim(),
      volumeName: env("DAYTONA_VOLUME_NAME", "poc-ephemeral-agent-sandbox"),
      image: env("DAYTONA_IMAGE", "node:22-bookworm"),
      snapshot: process.env.DAYTONA_SNAPSHOT?.trim(),
      createTimeoutSec: envInt("DAYTONA_CREATE_TIMEOUT_SEC", 120),
      commandTimeoutSec: envInt("DAYTONA_COMMAND_TIMEOUT_SEC", 900),
      deleteTimeoutSec: envInt("DAYTONA_DELETE_TIMEOUT_SEC", 60),
    },
    e2b: {
      apiKey: process.env.E2B_API_KEY?.trim(),
      template: env("E2B_TEMPLATE", "base"),
      volumePrefix: env("E2B_VOLUME_PREFIX", "poc-ephemeral-agent-sandbox"),
      useVolumes: envBool("E2B_USE_VOLUMES", true),
      storageMode: env("E2B_STORAGE_MODE", envBool("E2B_USE_VOLUMES", true) ? "volumes" : "ephemeral"),
      archil: {
        mountToken: process.env.E2B_ARCHIL_MOUNT_TOKEN?.trim(),
        disk: process.env.E2B_ARCHIL_DISK?.trim(),
        region: process.env.E2B_ARCHIL_REGION?.trim(),
        mountPath: env("E2B_ARCHIL_MOUNT_PATH", "/home/user/archil"),
      },
      createTimeoutSec: envInt("E2B_CREATE_TIMEOUT_SEC", 120),
      commandTimeoutSec: envInt("E2B_COMMAND_TIMEOUT_SEC", 900),
      deleteTimeoutSec: envInt("E2B_DELETE_TIMEOUT_SEC", 60),
    },
    blaxel: {
      apiKey: process.env.BL_API_KEY?.trim(),
      workspace: process.env.BL_WORKSPACE?.trim(),
      image: env("BLAXEL_IMAGE", "blaxel/base-image:latest"),
      volumePrefix: env("BLAXEL_VOLUME_PREFIX", "poc-ephemeral-agent-sandbox"),
      region: process.env.BLAXEL_REGION?.trim() || process.env.BL_REGION?.trim(),
      memoryMb: envInt("BLAXEL_MEMORY_MB", 4096),
      createTimeoutSec: envInt("BLAXEL_CREATE_TIMEOUT_SEC", 120),
      commandTimeoutSec: envInt("BLAXEL_COMMAND_TIMEOUT_SEC", 900),
      deleteTimeoutSec: envInt("BLAXEL_DELETE_TIMEOUT_SEC", 60),
      piInstallDeps: envBoolOptional("BLAXEL_PI_INSTALL_DEPS"),
    },
  };
}
