import { expect, test } from "vitest";
import { createSandboxProvider } from "../apps/control-plane/src/provider.js";
import { LocalSandboxProvider } from "../packages/sandbox/src/local-provider.js";
import { DaytonaSandboxProvider } from "../packages/sandbox/src/daytona-provider.js";

test("creates the local provider by default", () => {
  const provider = createSandboxProvider({
    sandboxProvider: "local",
    repoRoot: process.cwd(),
    daytona: {},
  });

  expect(provider).toBeInstanceOf(LocalSandboxProvider);
});

test("creates the Daytona provider when configured", () => {
  const provider = createSandboxProvider({
    sandboxProvider: "daytona",
    repoRoot: process.cwd(),
    daytona: {
      apiKey: "fake-key",
      volumeName: "poc-volume",
    },
  });

  expect(provider).toBeInstanceOf(DaytonaSandboxProvider);
});
