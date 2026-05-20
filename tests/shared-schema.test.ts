import { expect, test } from "vitest";
import { wakeRequestSchema } from "../packages/shared/src/index.js";

test("accepts agent and workspace ids that are safe disk path segments", () => {
  expect(() =>
    wakeRequestSchema.parse({
      source: "api",
      agentId: "agent-main_01",
      workspaceId: "workspace.demo-01",
      message: "hello",
    }),
  ).not.toThrow();
});

test("rejects agent and workspace ids with path separators or traversal", () => {
  expect(() =>
    wakeRequestSchema.parse({
      source: "api",
      agentId: "../agent-main",
      workspaceId: "workspace-demo",
      message: "hello",
    }),
  ).toThrow();

  expect(() =>
    wakeRequestSchema.parse({
      source: "api",
      agentId: "agent-main",
      workspaceId: "tenant/workspace-demo",
      message: "hello",
    }),
  ).toThrow();
});
