import { expect, test } from "vitest";
import { sandboxProviderNameSchema, wakeRequestSchema } from "../packages/shared/src/index.js";

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

test("accepts chat as a wake source", () => {
  const request = wakeRequestSchema.parse({
    source: "chat",
    agentId: "sales-agent",
    workspaceId: "sales-workspace",
    message: "hello",
  });

  expect(request.source).toBe("chat");
});

test("accepts all benchmark sandbox providers", () => {
  expect(sandboxProviderNameSchema.options).toEqual(expect.arrayContaining(["local", "daytona", "e2b", "blaxel"]));
});

test("accepts an explicit sandbox provider on wake requests", () => {
  const request = wakeRequestSchema.parse({
    source: "chat",
    agentId: "sales-agent",
    workspaceId: "sales-workspace",
    sandboxProvider: "e2b",
    message: "hello",
  });

  expect(request.sandboxProvider).toBe("e2b");
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
