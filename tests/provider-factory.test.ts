import { expect, test } from "vitest";
import { createSandboxProvider } from "../apps/control-plane/src/provider.js";
import { LocalSandboxProvider } from "../packages/sandbox/src/local-provider.js";
import { DaytonaSandboxProvider } from "../packages/sandbox/src/daytona-provider.js";
import { E2BSandboxProvider } from "../packages/sandbox/src/e2b-provider.js";
import { BlaxelSandboxProvider } from "../packages/sandbox/src/blaxel-provider.js";

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
    e2b: {},
    blaxel: {},
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
    e2b: {},
    blaxel: {},
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
    e2b: {},
    blaxel: {},
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
    e2b: {},
    blaxel: {},
  });

  expect(provider).toBeInstanceOf(DaytonaSandboxProvider);
  expect((provider as DaytonaSandboxProvider).getClientConfig()).toEqual(
    expect.objectContaining({
      jwtToken: "jwt-token",
      organizationId: "org-id",
    }),
  );
});

test("creates the E2B provider when configured", () => {
  const provider = createSandboxProvider({
    sandboxProvider: "e2b",
    repoRoot: process.cwd(),
    agentRuntime: {
      mode: "mock",
      pi: {
        model: "openai/gpt-5.5",
        thinkingLevel: "medium",
      },
    },
    daytona: {},
    e2b: {
      apiKey: "fake-e2b-key",
      template: "poc-template",
      volumePrefix: "poc-e2b",
    },
    blaxel: {},
  });

  expect(provider).toBeInstanceOf(E2BSandboxProvider);
  expect((provider as E2BSandboxProvider).getClientConfig()).toEqual({
    apiKey: "fake-e2b-key",
  });
});

test("creates the Blaxel provider when configured", () => {
  const provider = createSandboxProvider({
    sandboxProvider: "blaxel",
    repoRoot: process.cwd(),
    agentRuntime: {
      mode: "mock",
      pi: {
        model: "openai/gpt-5.5",
        thinkingLevel: "medium",
      },
    },
    daytona: {},
    e2b: {},
    blaxel: {
      apiKey: "fake-bl-key",
      workspace: "fake-workspace",
      image: "blaxel/base-image:latest",
      volumePrefix: "poc-blaxel",
      region: "us-pdx-1",
    },
  });

  expect(provider).toBeInstanceOf(BlaxelSandboxProvider);
  expect((provider as BlaxelSandboxProvider).getEnvironmentConfig()).toEqual({
    BL_API_KEY: "fake-bl-key",
    BL_WORKSPACE: "fake-workspace",
  });
});

test("defaults Blaxel Pi runs to installing dependencies even when global Pi install is disabled", () => {
  const provider = createSandboxProvider({
    sandboxProvider: "blaxel",
    repoRoot: process.cwd(),
    agentRuntime: {
      mode: "pi",
      pi: {
        model: "openai/gpt-4o-mini",
        thinkingLevel: "low",
        installDeps: false,
      },
    },
    daytona: {},
    e2b: {},
    blaxel: {
      apiKey: "fake-bl-key",
      workspace: "fake-workspace",
      image: "blaxel/base-image:latest",
      volumePrefix: "poc-blaxel",
      region: "us-pdx-1",
    },
  });

  expect((provider as BlaxelSandboxProvider).getAgentRuntimeConfig()).toEqual({
    mode: "pi",
    pi: {
      model: "openai/gpt-4o-mini",
      thinkingLevel: "low",
      installDeps: true,
    },
  });
});

test("allows Blaxel Pi dependency installation to be disabled for a baked Blaxel image", () => {
  const provider = createSandboxProvider({
    sandboxProvider: "blaxel",
    repoRoot: process.cwd(),
    agentRuntime: {
      mode: "pi",
      pi: {
        model: "openai/gpt-4o-mini",
        thinkingLevel: "low",
        installDeps: true,
      },
    },
    daytona: {},
    e2b: {},
    blaxel: {
      apiKey: "fake-bl-key",
      workspace: "fake-workspace",
      image: "custom-blaxel-pi:latest",
      piInstallDeps: false,
    },
  });

  expect((provider as BlaxelSandboxProvider).getAgentRuntimeConfig().pi.installDeps).toBe(false);
});
