import { expect, test } from "vitest";
import {
  e2bPiArchilTemplateCommands,
  e2bPiPackageJson,
  upsertEnvValue,
} from "../scripts/e2b-pi-archil-template.js";

test("defines an E2B Archil template that preinstalls Pi dependencies", () => {
  const commands = e2bPiArchilTemplateCommands("0.75.4");

  expect(commands).toEqual([
    "curl -fsSL https://archil.com/install | sh",
    "mkdir -p /home/user/agentruntime/harness",
    expect.stringContaining('"@earendil-works/pi-coding-agent":"0.75.4"'),
    "cd /home/user/agentruntime/harness && npm install --omit=dev",
    expect.stringContaining("major < 22"),
    "node --version && npm --version && sudo archil --help >/dev/null",
    "npm cache clean --force",
  ]);
});

test("renders the Pi package manifest used by the E2B template", () => {
  expect(JSON.parse(e2bPiPackageJson("1.2.3"))).toEqual({
    type: "module",
    dependencies: {
      "@earendil-works/pi-coding-agent": "1.2.3",
    },
  });
});

test("upserts E2B_TEMPLATE in dotenv contents without disturbing other secrets", () => {
  const updated = upsertEnvValue("E2B_API_KEY=e2b_secret\nE2B_TEMPLATE=old-template\nOPENAI_API_KEY=sk_secret\n", "E2B_TEMPLATE", "poc-pi-archil");

  expect(updated).toBe("E2B_API_KEY=e2b_secret\nE2B_TEMPLATE=poc-pi-archil\nOPENAI_API_KEY=sk_secret\n");
});
