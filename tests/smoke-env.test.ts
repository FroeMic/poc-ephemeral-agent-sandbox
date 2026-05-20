import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, test } from "vitest";
import { assertDaytonaCredentials, loadDotEnvFile } from "../scripts/smoke-daytona-pi.js";

const tempDirs: string[] = [];
const originalEnv = { ...process.env };

async function makeTempDir() {
  const dir = await mkdtemp(path.join(os.tmpdir(), "poc-smoke-env-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  process.env = { ...originalEnv };
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

test("loads simple .env values without overriding exported environment variables", async () => {
  const dir = await makeTempDir();
  process.env.DAYTONA_API_KEY = "exported-key";
  delete process.env.OPENAI_API_KEY;

  await writeFile(
    path.join(dir, ".env"),
    [
      "DAYTONA_API_KEY=file-key",
      "OPENAI_API_KEY=file-openai-key",
      "PI_MODEL=\"openai/gpt-5.5\"",
      "IGNORED_EMPTY=",
      "# comment",
      "",
    ].join("\n"),
    "utf8",
  );

  await loadDotEnvFile(path.join(dir, ".env"));

  expect(process.env.DAYTONA_API_KEY).toBe("exported-key");
  expect(process.env.OPENAI_API_KEY).toBe("file-openai-key");
  expect(process.env.PI_MODEL).toBe("openai/gpt-5.5");
  expect(process.env.IGNORED_EMPTY).toBe("");
});

test("accepts Daytona JWT and organization credentials for smoke auth preflight", () => {
  delete process.env.DAYTONA_API_KEY;
  process.env.DAYTONA_JWT_TOKEN = "jwt-token";
  process.env.DAYTONA_ORGANIZATION_ID = "org-id";

  expect(() => assertDaytonaCredentials()).not.toThrow();
});

test("requires either Daytona API key or JWT plus organization credentials", () => {
  delete process.env.DAYTONA_API_KEY;
  process.env.DAYTONA_JWT_TOKEN = "jwt-token";
  delete process.env.DAYTONA_ORGANIZATION_ID;

  expect(() => assertDaytonaCredentials()).toThrow("DAYTONA_API_KEY or DAYTONA_JWT_TOKEN plus DAYTONA_ORGANIZATION_ID is required");
});
