import { DaytonaSandboxProvider, LocalSandboxProvider, type SandboxProvider } from "@poc/sandbox";

export type ProviderFactoryConfig = {
  sandboxProvider: string;
  repoRoot: string;
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
    return new DaytonaSandboxProvider(config.daytona);
  }

  throw new Error(`Unsupported SANDBOX_PROVIDER: ${config.sandboxProvider}`);
}
