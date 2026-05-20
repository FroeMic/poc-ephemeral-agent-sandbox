import { expect, test } from "vitest";
import { createSandboxProvider } from "../apps/control-plane/src/provider.js";
import { LocalSandboxProvider } from "../packages/sandbox/src/local-provider.js";
import { DaytonaSandboxProvider } from "../packages/sandbox/src/daytona-provider.js";

test("creates the local provider by default", () => {
  const provider = createSandboxProvider({
    sandboxProvider: "local",
    repoRoot: process.cwd(),
    agentRuntime: {
      mode: "mock",
      pi: {
        model: "openai/gpt-5.5",
        thinkingLevel: "medium",
      },
    },
    daytona: {},
  });

  expect(provider).toBeInstanceOf(LocalSandboxProvider);
});

test("creates the Daytona provider when configured", () => {
  const provider = createSandboxProvider({
    sandboxProvider: "daytona",
    repoRoot: process.cwd(),
    agentRuntime: {
      mode: "mock",
      pi: {
        model: "openai/gpt-5.5",
        thinkingLevel: "medium",
      },
    },
    daytona: {
      apiKey: "fake-key",
      volumeName: "poc-volume",
    },
  });

  expect(provider).toBeInstanceOf(DaytonaSandboxProvider);
});

test("passes agent runtime config into the Daytona provider", () => {
  const provider = createSandboxProvider({
    sandboxProvider: "daytona",
    repoRoot: process.cwd(),
    agentRuntime: {
      mode: "pi",
      pi: {
        model: "openai/gpt-5.5",
        thinkingLevel: "high",
      },
    },
    daytona: {
      apiKey: "fake-key",
      volumeName: "poc-volume",
    },
  });

  expect(provider).toBeInstanceOf(DaytonaSandboxProvider);
  expect((provider as DaytonaSandboxProvider).getAgentRuntimeConfig()).toEqual({
    mode: "pi",
    pi: {
      model: "openai/gpt-5.5",
      thinkingLevel: "high",
    },
  });
});

test("passes Daytona JWT authentication config into the Daytona provider", () => {
  const provider = createSandboxProvider({
    sandboxProvider: "daytona",
    repoRoot: process.cwd(),
    agentRuntime: {
      mode: "mock",
      pi: {
        model: "openai/gpt-5.5",
        thinkingLevel: "medium",
      },
    },
    daytona: {
      jwtToken: "jwt-token",
      organizationId: "org-id",
      volumeName: "poc-volume",
    },
  });

  expect(provider).toBeInstanceOf(DaytonaSandboxProvider);
  expect((provider as DaytonaSandboxProvider).getClientConfig()).toEqual(
    expect.objectContaining({
      jwtToken: "jwt-token",
      organizationId: "org-id",
    }),
  );
});
