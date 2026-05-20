import path from "node:path";
import type { AgentRuntimeMode } from "@poc/sandbox";

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
      },
    },
    daytona: {
      apiKey: process.env.DAYTONA_API_KEY?.trim(),
      apiUrl: process.env.DAYTONA_API_URL?.trim(),
      target: process.env.DAYTONA_TARGET?.trim(),
      volumeName: env("DAYTONA_VOLUME_NAME", "poc-ephemeral-agent-sandbox"),
      image: env("DAYTONA_IMAGE", "node:22-bookworm"),
      snapshot: process.env.DAYTONA_SNAPSHOT?.trim(),
      createTimeoutSec: envInt("DAYTONA_CREATE_TIMEOUT_SEC", 120),
      commandTimeoutSec: envInt("DAYTONA_COMMAND_TIMEOUT_SEC", 900),
      deleteTimeoutSec: envInt("DAYTONA_DELETE_TIMEOUT_SEC", 60),
    },
  };
}
