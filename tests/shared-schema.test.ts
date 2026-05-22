import { expect, test } from "vitest";
import { runEventSchema, sandboxProviderNameSchema, wakeRequestSchema } from "../packages/shared/src/index.js";

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

test("accepts phase timing run events", () => {
  const event = runEventSchema.parse({
    type: "phase_timing",
    runId: "run_123",
    timestamp: "2026-05-22T00:00:00.000Z",
    provider: "blaxel",
    phase: "sandbox_acquire",
    durationMs: 1234,
    status: "succeeded",
    metadata: {
      scenario: "blaxel-pi-baked-volume",
    },
  });

  expect(event).toEqual(
    expect.objectContaining({
      type: "phase_timing",
      phase: "sandbox_acquire",
      durationMs: 1234,
      status: "succeeded",
    }),
  );
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
