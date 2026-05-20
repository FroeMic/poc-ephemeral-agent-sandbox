import { expect, test } from "vitest";
import { createRequire } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";
import type { CreateSandboxFromImageParams, CreateSandboxFromSnapshotParams, VolumeMount } from "@daytonaio/sdk";

type DaytonaSdk = {
  Daytona: typeof import("@daytonaio/sdk").Daytona;
};

test("installed Daytona SDK supports persistent volume subpath mounts on image sandboxes", () => {
  const mount: VolumeMount = {
    volumeId: "volume-123",
    mountPath: "/agent-home",
    subpath: "agents/agent-main",
  };
  const params: CreateSandboxFromImageParams = {
    image: "node:22-bookworm",
    ephemeral: true,
    volumes: [mount],
  };

  expect(params.volumes?.[0]).toEqual(mount);
});

test("installed Daytona SDK supports persistent volume subpath mounts on snapshot sandboxes", () => {
  const mount: VolumeMount = {
    volumeId: "volume-123",
    mountPath: "/workspace",
    subpath: "workspaces/workspace-demo",
  };
  const params: CreateSandboxFromSnapshotParams = {
    snapshot: "snapshot-name",
    ephemeral: true,
    volumes: [mount],
  };

  expect(params.volumes?.[0]).toEqual(mount);
});

test("installed Daytona SDK exposes the services used by the provider", async () => {
  const requireFromSandbox = createRequire(`${process.cwd()}/packages/sandbox/package.json`);
  const packageJsonPath = requireFromSandbox.resolve("@daytonaio/sdk/package.json");
  const sdk = (await import(
    pathToFileURL(path.join(path.dirname(packageJsonPath), "esm", "index.js")).href
  )) as DaytonaSdk;
  const { Daytona } = sdk;

  expect(typeof Daytona).toBe("function");
  expect(typeof Daytona.prototype.create).toBe("function");
});
