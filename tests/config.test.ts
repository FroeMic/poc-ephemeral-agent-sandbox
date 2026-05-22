import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, test } from "vitest";
import { loadDotEnvFiles, readConfig } from "../apps/control-plane/src/config.js";

const originalEnv = { ...process.env };
const originalCwd = process.cwd();
const tempDirs: string[] = [];

afterEach(async () => {
  process.chdir(originalCwd);
  process.env = { ...originalEnv };
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function makeTempDir() {
  const dir = await mkdtemp(path.join(os.tmpdir(), "poc-config-"));
  tempDirs.push(dir);
  return dir;
}

test("defaults to the mock agent runtime mode", () => {
  delete process.env.AGENT_RUNTIME_MODE;

  expect(readConfig().agentRuntime.mode).toBe("mock");
});

test("reads Pi agent runtime settings from the environment", () => {
  process.env.AGENT_RUNTIME_MODE = "pi";
  process.env.PI_MODEL = "openai/gpt-5.5";
  process.env.PI_THINKING_LEVEL = "high";
  process.env.PI_INSTALL_DEPS = "false";

  expect(readConfig().agentRuntime).toEqual({
    mode: "pi",
    pi: {
      model: "openai/gpt-5.5",
      thinkingLevel: "high",
      installDeps: false,
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

test("reads E2B provider settings from the environment", () => {
  process.env.E2B_API_KEY = "e2b-key";
  process.env.E2B_TEMPLATE = "poc-node-template";
  process.env.E2B_VOLUME_PREFIX = "poc-e2b";
  process.env.E2B_CREATE_TIMEOUT_SEC = "45";
  process.env.E2B_COMMAND_TIMEOUT_SEC = "300";
  process.env.E2B_DELETE_TIMEOUT_SEC = "30";
  process.env.E2B_USE_VOLUMES = "false";
  process.env.E2B_STORAGE_MODE = "archil";
  process.env.E2B_ARCHIL_MOUNT_TOKEN = "archil-token";
  process.env.E2B_ARCHIL_DISK = "org/disk";
  process.env.E2B_ARCHIL_REGION = "aws-us-east-1";

  expect(readConfig().e2b).toEqual({
    apiKey: "e2b-key",
    template: "poc-node-template",
    volumePrefix: "poc-e2b",
    useVolumes: false,
    storageMode: "archil",
    archil: {
      mountToken: "archil-token",
      disk: "org/disk",
      region: "aws-us-east-1",
      mountPath: "/home/user/archil",
    },
    createTimeoutSec: 45,
    commandTimeoutSec: 300,
    deleteTimeoutSec: 30,
  });
});

test("reads Blaxel provider settings from the environment", () => {
  process.env.BL_API_KEY = "bl-key";
  process.env.BL_WORKSPACE = "workspace";
  process.env.BLAXEL_IMAGE = "blaxel/base-image:latest";
  process.env.BLAXEL_VOLUME_PREFIX = "poc-blaxel";
  process.env.BLAXEL_REGION = "us-pdx-1";
  process.env.BLAXEL_MEMORY_MB = "4096";
  process.env.BLAXEL_CREATE_TIMEOUT_SEC = "60";
  process.env.BLAXEL_COMMAND_TIMEOUT_SEC = "300";
  process.env.BLAXEL_DELETE_TIMEOUT_SEC = "30";
  process.env.BLAXEL_PI_INSTALL_DEPS = "false";

  expect(readConfig().blaxel).toEqual({
    apiKey: "bl-key",
    workspace: "workspace",
    image: "blaxel/base-image:latest",
    volumePrefix: "poc-blaxel",
    region: "us-pdx-1",
    memoryMb: 4096,
    createTimeoutSec: 60,
    commandTimeoutSec: 300,
    deleteTimeoutSec: 30,
    piInstallDeps: false,
  });
});

test("loads .env before server config without overriding exported env", async () => {
  const dir = await makeTempDir();
  await writeFile(
    path.join(dir, ".env"),
    ["E2B_API_KEY=from-file", "BL_WORKSPACE=interaction42", "PI_THINKING_LEVEL=from-file", ""].join("\n"),
    "utf8",
  );
  process.env.PI_THINKING_LEVEL = "exported";

  await loadDotEnvFiles(dir);

  expect(process.env.E2B_API_KEY).toBe("from-file");
  expect(process.env.BL_WORKSPACE).toBe("interaction42");
  expect(process.env.PI_THINKING_LEVEL).toBe("exported");
});
