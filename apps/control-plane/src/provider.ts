import {
  BlaxelSandboxProvider,
  DaytonaSandboxProvider,
  E2BSandboxProvider,
  LocalSandboxProvider,
  type AgentRuntimeConfig,
  type SandboxProvider,
} from "@poc/sandbox";

export type ProviderFactoryConfig = {
  sandboxProvider: string;
  repoRoot: string;
  agentRuntime: AgentRuntimeConfig;
  daytona: {
    apiKey?: string | undefined;
    jwtToken?: string | undefined;
    organizationId?: string | undefined;
    apiUrl?: string | undefined;
    target?: string | undefined;
    volumeName?: string | undefined;
    image?: string | undefined;
    snapshot?: string | undefined;
    createTimeoutSec?: number | undefined;
    commandTimeoutSec?: number | undefined;
    deleteTimeoutSec?: number | undefined;
  };
  e2b: {
    apiKey?: string | undefined;
    template?: string | undefined;
    volumePrefix?: string | undefined;
    useVolumes?: boolean | undefined;
    storageMode?: string | undefined;
    archil?: {
      mountToken?: string | undefined;
      disk?: string | undefined;
      region?: string | undefined;
      mountPath?: string | undefined;
    };
    createTimeoutSec?: number | undefined;
    commandTimeoutSec?: number | undefined;
    deleteTimeoutSec?: number | undefined;
  };
  blaxel: {
    apiKey?: string | undefined;
    workspace?: string | undefined;
    image?: string | undefined;
    volumePrefix?: string | undefined;
    region?: string | undefined;
    memoryMb?: number | undefined;
    createTimeoutSec?: number | undefined;
    commandTimeoutSec?: number | undefined;
    deleteTimeoutSec?: number | undefined;
    piInstallDeps?: boolean | undefined;
  };
};

function withPiInstallDeps(config: AgentRuntimeConfig, installDeps: boolean): AgentRuntimeConfig {
  if (config.mode !== "pi") return config;
  return {
    ...config,
    pi: {
      ...config.pi,
      installDeps,
    },
  };
}

export function createSandboxProvider(config: ProviderFactoryConfig): SandboxProvider {
  if (config.sandboxProvider === "local") {
    return new LocalSandboxProvider({ repoRoot: config.repoRoot });
  }

  if (config.sandboxProvider === "daytona") {
    return new DaytonaSandboxProvider({
      ...(config.daytona.apiKey ? { apiKey: config.daytona.apiKey } : {}),
      ...(config.daytona.jwtToken ? { jwtToken: config.daytona.jwtToken } : {}),
      ...(config.daytona.organizationId ? { organizationId: config.daytona.organizationId } : {}),
      ...(config.daytona.apiUrl ? { apiUrl: config.daytona.apiUrl } : {}),
      ...(config.daytona.target ? { target: config.daytona.target } : {}),
      ...(config.daytona.volumeName ? { volumeName: config.daytona.volumeName } : {}),
      ...(config.daytona.image ? { image: config.daytona.image } : {}),
      ...(config.daytona.snapshot ? { snapshot: config.daytona.snapshot } : {}),
      ...(config.daytona.createTimeoutSec ? { createTimeoutSec: config.daytona.createTimeoutSec } : {}),
      ...(config.daytona.commandTimeoutSec ? { commandTimeoutSec: config.daytona.commandTimeoutSec } : {}),
      ...(config.daytona.deleteTimeoutSec ? { deleteTimeoutSec: config.daytona.deleteTimeoutSec } : {}),
      agentRuntime: config.agentRuntime,
    });
  }

  if (config.sandboxProvider === "e2b") {
    return new E2BSandboxProvider({
      ...(config.e2b.apiKey ? { apiKey: config.e2b.apiKey } : {}),
      ...(config.e2b.template ? { template: config.e2b.template } : {}),
      ...(config.e2b.volumePrefix ? { volumePrefix: config.e2b.volumePrefix } : {}),
      ...(config.e2b.useVolumes !== undefined ? { useVolumes: config.e2b.useVolumes } : {}),
      ...(config.e2b.storageMode === "volumes" || config.e2b.storageMode === "ephemeral" || config.e2b.storageMode === "archil"
        ? { storageMode: config.e2b.storageMode }
        : {}),
      ...(config.e2b.archil ? { archil: config.e2b.archil } : {}),
      ...(config.e2b.createTimeoutSec ? { createTimeoutSec: config.e2b.createTimeoutSec } : {}),
      ...(config.e2b.commandTimeoutSec ? { commandTimeoutSec: config.e2b.commandTimeoutSec } : {}),
      ...(config.e2b.deleteTimeoutSec ? { deleteTimeoutSec: config.e2b.deleteTimeoutSec } : {}),
      agentRuntime: config.agentRuntime,
    });
  }

  if (config.sandboxProvider === "blaxel") {
    return new BlaxelSandboxProvider({
      ...(config.blaxel.apiKey ? { apiKey: config.blaxel.apiKey } : {}),
      ...(config.blaxel.workspace ? { workspace: config.blaxel.workspace } : {}),
      ...(config.blaxel.image ? { image: config.blaxel.image } : {}),
      ...(config.blaxel.volumePrefix ? { volumePrefix: config.blaxel.volumePrefix } : {}),
      ...(config.blaxel.region ? { region: config.blaxel.region } : {}),
      ...(config.blaxel.memoryMb ? { memoryMb: config.blaxel.memoryMb } : {}),
      ...(config.blaxel.createTimeoutSec ? { createTimeoutSec: config.blaxel.createTimeoutSec } : {}),
      ...(config.blaxel.commandTimeoutSec ? { commandTimeoutSec: config.blaxel.commandTimeoutSec } : {}),
      ...(config.blaxel.deleteTimeoutSec ? { deleteTimeoutSec: config.blaxel.deleteTimeoutSec } : {}),
      agentRuntime: withPiInstallDeps(config.agentRuntime, config.blaxel.piInstallDeps ?? true),
    });
  }

  throw new Error(`Unsupported SANDBOX_PROVIDER: ${config.sandboxProvider}`);
}
