import path from "node:path";

function env(name: string, fallback: string) {
  const value = process.env[name]?.trim();
  return value && value.length > 0 ? value : fallback;
}

export function readConfig() {
  const repoRoot = process.cwd();
  return {
    repoRoot,
    port: Number.parseInt(env("PORT", "3000"), 10),
    controlPlaneUrl: env("CONTROL_PLANE_URL", "http://localhost:3000"),
    dataDir: path.resolve(repoRoot, env("DATA_DIR", "./data")),
    sharedBundleVersion: env("SHARED_BUNDLE_VERSION", "v1"),
    sandboxProvider: env("SANDBOX_PROVIDER", "local"),
    daytona: {
      apiKey: process.env.DAYTONA_API_KEY?.trim(),
      apiUrl: process.env.DAYTONA_API_URL?.trim(),
      target: process.env.DAYTONA_TARGET?.trim(),
      volumeName: env("DAYTONA_VOLUME_NAME", "poc-ephemeral-agent-sandbox"),
      image: env("DAYTONA_IMAGE", "node:22-bookworm"),
      snapshot: process.env.DAYTONA_SNAPSHOT?.trim(),
    },
  };
}
