import { readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";

type E2BTemplateSdk = typeof import("e2b");

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

export function e2bPiPackageJson(piVersion: string) {
  return JSON.stringify({
    type: "module",
    dependencies: {
      "@earendil-works/pi-coding-agent": piVersion,
    },
  });
}

export function e2bPiArchilTemplateCommands(piVersion: string) {
  return [
    "curl -fsSL https://archil.com/install | sh",
    "mkdir -p /home/user/agentruntime/harness",
    `printf %s ${shellSingleQuote(e2bPiPackageJson(piVersion))} > /home/user/agentruntime/harness/package.json`,
    "cd /home/user/agentruntime/harness && npm install --omit=dev",
    'node -e "const [major, minor] = process.versions.node.split(\'.\').map(Number); if (major < 22 || (major === 22 && minor < 19)) process.exit(1)"',
    "node --version && npm --version && sudo archil --help >/dev/null",
    "npm cache clean --force",
  ];
}

export function upsertEnvValue(contents: string, key: string, value: string) {
  const lines = contents.split(/\n/);
  const assignment = `${key}=${value}`;
  const index = lines.findIndex((line) => line.match(new RegExp(`^\\s*${key}\\s*=`)));
  if (index >= 0) {
    lines[index] = assignment;
    return lines.join("\n");
  }
  if (lines.length === 0 || lines[lines.length - 1] !== "") lines.push("");
  lines.splice(lines.length - 1, 0, assignment);
  return lines.join("\n");
}

async function loadDotEnv(filePath: string) {
  let contents: string;
  try {
    contents = await readFile(filePath, "utf8");
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return "";
    throw error;
  }

  for (const line of contents.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const separator = trimmed.indexOf("=");
    if (separator === -1) continue;
    const key = trimmed.slice(0, separator).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;
    if (process.env[key] !== undefined) continue;
    process.env[key] = trimmed.slice(separator + 1).trim().replace(/^(['"])(.*)\1$/, "$2");
  }
  return contents;
}

async function loadE2BTemplateSdk(): Promise<E2BTemplateSdk> {
  const requireFromSandbox = createRequire(`${process.cwd()}/packages/sandbox/package.json`);
  return requireFromSandbox("e2b") as E2BTemplateSdk;
}

export async function buildE2BPiArchilTemplate() {
  const envPath = path.resolve(process.cwd(), ".env");
  const envContents = await loadDotEnv(envPath);
  const apiKey = process.env.E2B_API_KEY?.trim();
  if (!apiKey) throw new Error("E2B_API_KEY is required in .env or the process environment");

  const { Template, defaultBuildLogger } = await loadE2BTemplateSdk();
  const piVersion = env("PI_CODING_AGENT_VERSION", "0.75.4");
  const templateName = env("E2B_PI_ARCHIL_TEMPLATE_NAME", "poc-pi-archil");
  const baseTemplate = process.env.E2B_PI_ARCHIL_BASE_TEMPLATE?.trim();
  const nodeVariant = env("E2B_PI_ARCHIL_NODE_VARIANT", "22");
  const cpuCount = envInt("E2B_TEMPLATE_CPU_COUNT", 2);
  const memoryMB = envInt("E2B_TEMPLATE_MEMORY_MB", 4096);
  const skipCache = env("E2B_TEMPLATE_SKIP_CACHE", "false").toLowerCase() === "true";

  const template = (baseTemplate ? Template().fromTemplate(baseTemplate) : Template().fromNodeImage(nodeVariant))
    .aptInstall(["libfuse2", "ca-certificates"])
    .runCmd(e2bPiArchilTemplateCommands(piVersion));

  process.stdout.write(
    `Building E2B template '${templateName}' from '${baseTemplate ?? `node:${nodeVariant}`}' with Pi ${piVersion} and Archil...\n`,
  );
  const buildInfo = await Template.build(template, templateName, {
    apiKey,
    cpuCount,
    memoryMB,
    skipCache,
    onBuildLogs: defaultBuildLogger(),
  });

  let updated = envContents;
  updated = upsertEnvValue(updated, "E2B_TEMPLATE", buildInfo.name);
  updated = upsertEnvValue(updated, "E2B_STORAGE_MODE", "archil");
  updated = upsertEnvValue(updated, "E2B_USE_VOLUMES", "false");
  updated = upsertEnvValue(updated, "E2B_ARCHIL_MOUNT_PATH", "/home/user/archil");
  updated = upsertEnvValue(updated, "PI_INSTALL_DEPS", "false");
  await writeFile(envPath, updated, { mode: 0o600 });

  process.stdout.write(`\nTemplate ready: ${buildInfo.name} (${buildInfo.templateId})\n`);
  process.stdout.write("Updated .env with E2B_TEMPLATE, Archil storage mode, and PI_INSTALL_DEPS=false.\n");
  return buildInfo;
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(decodeURIComponent(new URL(import.meta.url).pathname))) {
  buildE2BPiArchilTemplate().catch((error) => {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`${message.replace(/(?:dtn|sk|sk-proj|e2b|bl|adt)_[A-Za-z0-9_-]+/g, "[redacted]")}\n`);
    process.exitCode = 1;
  });
}
