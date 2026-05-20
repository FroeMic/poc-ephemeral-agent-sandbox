import { DaytonaSandboxProvider, LocalSandboxProvider, type AgentRuntimeConfig, type SandboxProvider } from "@poc/sandbox";

export type ProviderFactoryConfig = {
  sandboxProvider: string;
  repoRoot: string;
  agentRuntime: AgentRuntimeConfig;
  daytona: {
    apiKey?: string | undefined;
    apiUrl?: string | undefined;
    target?: string | undefined;
    volumeName?: string | undefined;
    image?: string | undefined;
    snapshot?: string | undefined;
  };
};

export function createSandboxProvider(config: ProviderFactoryConfig): SandboxProvider {
  if (config.sandboxProvider === "local") {
    return new LocalSandboxProvider({ repoRoot: config.repoRoot });
  }

  if (config.sandboxProvider === "daytona") {
    return new DaytonaSandboxProvider({ ...config.daytona, agentRuntime: config.agentRuntime });
  }

  throw new Error(`Unsupported SANDBOX_PROVIDER: ${config.sandboxProvider}`);
}
