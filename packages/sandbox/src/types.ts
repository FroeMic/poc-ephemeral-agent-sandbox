import type { RunEvent, RuntimeWakePayload, SandboxProviderName } from "@poc/shared";

export type AgentRuntimeMode = "mock" | "pi";

export type AgentRuntimeConfig = {
  mode: AgentRuntimeMode;
  pi: {
    model: string;
    thinkingLevel: string;
    installDeps?: boolean;
  };
};

export type SandboxHandle = {
  provider: SandboxProviderName;
  sandboxId: string;
  runtimePaths?: {
    agentHomePath: string;
    workspacePath: string;
    sharedPath: string;
    runPath: string;
    wakePath: string;
  };
};

export type StartRunInput = {
  runId: string;
  agentId: string;
  workspaceId: string;
  agentHomePath: string;
  workspacePath: string;
  sharedPath: string;
  runPath: string;
  wakePath: string;
};

export type ExecInput = {
  handle: SandboxHandle;
  payload: RuntimeWakePayload;
};

export interface SandboxProvider {
  readonly name: SandboxProviderName;
  startRun(input: StartRunInput): Promise<SandboxHandle>;
  exec(input: ExecInput): AsyncIterable<RunEvent>;
  stop(handle: SandboxHandle): Promise<void>;
}
