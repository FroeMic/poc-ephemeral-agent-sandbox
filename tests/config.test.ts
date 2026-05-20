import { afterEach, expect, test } from "vitest";
import { readConfig } from "../apps/control-plane/src/config.js";

const originalEnv = { ...process.env };

afterEach(() => {
  process.env = { ...originalEnv };
});

test("defaults to the mock agent runtime mode", () => {
  delete process.env.AGENT_RUNTIME_MODE;

  expect(readConfig().agentRuntime.mode).toBe("mock");
});

test("reads Pi agent runtime settings from the environment", () => {
  process.env.AGENT_RUNTIME_MODE = "pi";
  process.env.PI_MODEL = "openai/gpt-5.5";
  process.env.PI_THINKING_LEVEL = "high";

  expect(readConfig().agentRuntime).toEqual({
    mode: "pi",
    pi: {
      model: "openai/gpt-5.5",
      thinkingLevel: "high",
    },
  });
});

test("reads Daytona timeout settings from the environment", () => {
  process.env.DAYTONA_CREATE_TIMEOUT_SEC = "180";
  process.env.DAYTONA_COMMAND_TIMEOUT_SEC = "900";
  process.env.DAYTONA_DELETE_TIMEOUT_SEC = "90";

  expect(readConfig().daytona).toEqual(
    expect.objectContaining({
      createTimeoutSec: 180,
      commandTimeoutSec: 900,
      deleteTimeoutSec: 90,
    }),
  );
});

test("reads Daytona JWT authentication settings from the environment", () => {
  process.env.DAYTONA_JWT_TOKEN = "jwt-token";
  process.env.DAYTONA_ORGANIZATION_ID = "org-id";

  expect(readConfig().daytona).toEqual(
    expect.objectContaining({
      jwtToken: "jwt-token",
      organizationId: "org-id",
    }),
  );
});
