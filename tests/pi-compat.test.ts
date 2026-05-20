import { expect, test } from "vitest";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { readConfig } from "../apps/control-plane/src/config.js";

type PiCodingAgent = {
  AuthStorage: {
    inMemory(): unknown;
  };
  ModelRegistry: {
    inMemory(authStorage: unknown): {
      find(provider: string, modelId: string): unknown;
    };
  };
};

test("default Pi model exists in the installed Pi model registry", async () => {
  delete process.env.PI_MODEL;
  const modelName = readConfig().agentRuntime.pi.model;
  const separator = modelName.indexOf("/");
  const provider = modelName.slice(0, separator);
  const modelId = modelName.slice(separator + 1);
  const pi = (await import(
    pathToFileURL(
      path.resolve(
        process.cwd(),
        "packages/agentruntime/node_modules/@earendil-works/pi-coding-agent/dist/index.js",
      ),
    ).href
  )) as PiCodingAgent;
  const { AuthStorage, ModelRegistry } = pi;
  const registry = ModelRegistry.inMemory(AuthStorage.inMemory());

  expect(registry.find(provider, modelId)).toBeDefined();
});
