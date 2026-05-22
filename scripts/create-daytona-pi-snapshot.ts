import { createRequire } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { loadDotEnvFiles, assertDaytonaCredentials } from "./smoke-daytona-pi.js";

type DaytonaSdk = typeof import("@daytonaio/sdk");

function env(name: string, fallback: string) {
  const value = process.env[name]?.trim();
  return value && value.length > 0 ? value : fallback;
}

function envInt(name: string, fallback: number) {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) throw new Error(`${name} must be a positive integer`);
  return parsed;
}

function shellSingleQuote(value: string) {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

async function main() {
  await loadDotEnvFiles();
  assertDaytonaCredentials();

  const requireFromSandbox = createRequire(`${process.cwd()}/packages/sandbox/package.json`);
  const packageJsonPath = requireFromSandbox.resolve("@daytonaio/sdk/package.json");
  const sdk = (await import(pathToFileURL(path.join(path.dirname(packageJsonPath), "esm", "index.js")).href)) as DaytonaSdk;
  const { Daytona, Image } = sdk;

  const snapshotName = env("DAYTONA_PI_SNAPSHOT_NAME", "poc-pi-runner");
  const baseImage = env("DAYTONA_PI_SNAPSHOT_BASE_IMAGE", env("DAYTONA_IMAGE", "node:22-bookworm"));
  const timeoutSec = envInt("DAYTONA_SNAPSHOT_TIMEOUT_SEC", 1800);
  const piVersion = env("PI_CODING_AGENT_VERSION", "0.75.4");

  const config = {
    ...(process.env.DAYTONA_API_KEY?.trim() ? { apiKey: process.env.DAYTONA_API_KEY.trim() } : {}),
    ...(process.env.DAYTONA_JWT_TOKEN?.trim() ? { jwtToken: process.env.DAYTONA_JWT_TOKEN.trim() } : {}),
    ...(process.env.DAYTONA_ORGANIZATION_ID?.trim() ? { organizationId: process.env.DAYTONA_ORGANIZATION_ID.trim() } : {}),
    ...(process.env.DAYTONA_API_URL?.trim() ? { apiUrl: process.env.DAYTONA_API_URL.trim() } : {}),
    ...(process.env.DAYTONA_TARGET?.trim() ? { target: process.env.DAYTONA_TARGET.trim() } : {}),
  };

  const packageJson = JSON.stringify({
    type: "module",
    dependencies: {
      "@earendil-works/pi-coding-agent": piVersion,
    },
  });

  const image = Image.base(baseImage).runCommands(
    "mkdir -p /agentruntime/harness",
    `printf %s ${shellSingleQuote(packageJson)} > /agentruntime/harness/package.json`,
    "cd /agentruntime/harness && npm install --omit=dev",
    "npm cache clean --force",
  );

  const daytona = new Daytona(config);
  process.stdout.write(`Creating Daytona Pi snapshot '${snapshotName}' from ${baseImage}...\n`);
  await daytona.snapshot.create(
    {
      name: snapshotName,
      image,
      ...(process.env.DAYTONA_SNAPSHOT_REGION?.trim() ? { regionId: process.env.DAYTONA_SNAPSHOT_REGION.trim() } : {}),
    },
    {
      timeout: timeoutSec,
      onLogs: (chunk) => process.stdout.write(chunk),
    },
  );
  process.stdout.write(`\nSnapshot ready: ${snapshotName}\n`);
  process.stdout.write("Use it with DAYTONA_SNAPSHOT and PI_INSTALL_DEPS=false.\n");
}

await main();
