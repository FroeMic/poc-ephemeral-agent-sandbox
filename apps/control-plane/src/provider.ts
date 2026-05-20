import { DaytonaSandboxProvider, LocalSandboxProvider, type AgentRuntimeConfig, type SandboxProvider } from "@poc/sandbox";

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
};

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

  throw new Error(`Unsupported SANDBOX_PROVIDER: ${config.sandboxProvider}`);
}
