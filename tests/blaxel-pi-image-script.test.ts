import { expect, test } from "vitest";
import {
  blaxelPiImageReference,
  buildBlaxelPushArgs,
  upsertDotEnvValues,
} from "../scripts/blaxel-pi-image.js";

test("builds a non-interactive Blaxel sandbox image push command", () => {
  expect(
    buildBlaxelPushArgs({
      sourceDir: "pi-sandbox",
      imageName: "poc-pi-runner",
      timeout: "30m",
      workspace: "interaction42",
    }),
  ).toEqual([
    "push",
    "--directory",
    "pi-sandbox",
    "--type",
    "sandbox",
    "--name",
    "poc-pi-runner",
    "--timeout",
    "30m",
    "--workspace",
    "interaction42",
    "--yes",
  ]);
});

test("normalizes a Blaxel image name to a latest image reference", () => {
  expect(blaxelPiImageReference("poc-pi-runner")).toBe("sandbox/poc-pi-runner:latest");
  expect(blaxelPiImageReference("registry.example.com/poc-pi-runner:v1")).toBe("registry.example.com/poc-pi-runner:v1");
});

test("upserts Blaxel baked image settings without duplicating keys", () => {
  const original = ["SANDBOX_PROVIDER=blaxel", "BLAXEL_IMAGE=blaxel/base-image:latest", "BLAXEL_PI_INSTALL_DEPS=true", ""].join("\n");

  expect(
    upsertDotEnvValues(original, {
      BLAXEL_IMAGE: "sandbox/poc-pi-runner:latest",
      BLAXEL_PI_INSTALL_DEPS: "false",
    }),
  ).toBe(["SANDBOX_PROVIDER=blaxel", "BLAXEL_IMAGE=sandbox/poc-pi-runner:latest", "BLAXEL_PI_INSTALL_DEPS=false", ""].join("\n"));
});
