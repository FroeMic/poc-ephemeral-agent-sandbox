import { expect, test } from "vitest";
import { renderDashboardHtml } from "../apps/control-plane/src/dashboard.js";

test("renders a browser dashboard that can create wakes and inspect events", () => {
  const html = renderDashboardHtml();

  expect(html).toContain("<!doctype html>");
  expect(html).toContain("Agent Chat");
  expect(html).toContain(">Send</button>");
  expect(html).toContain('fetch("/chat-turn"');
  expect(html).not.toContain('fetch("/runs/" + runId + "/events")');
});

test("renders three isolated chat agents backed by Daytona volume ids", () => {
  const html = renderDashboardHtml();

  expect(html).toContain("sales-agent");
  expect(html).toContain("sales-workspace");
  expect(html).toContain("support-agent");
  expect(html).toContain("support-workspace");
  expect(html).toContain("ops-agent");
  expect(html).toContain("ops-workspace");
});

test("chat wake payload includes selected agent ids and prior transcript context", () => {
  const html = renderDashboardHtml();

  expect(html).toContain('source: "chat"');
  expect(html).toContain("requestAgent.agentId");
  expect(html).toContain("requestAgent.workspaceId");
  expect(html).toContain("sandboxProvider: activeProvider");
  expect(html).toContain("buildWakeMessage");
  expect(html).toContain("Conversation so far:");
  expect(html).toContain("localStorage");
});

test("renders a provider selector for local, Daytona, E2B, and Blaxel", () => {
  const html = renderDashboardHtml();

  expect(html).toContain('id="provider-select"');
  expect(html).toContain('value="local"');
  expect(html).toContain('value="daytona"');
  expect(html).toContain('value="e2b"');
  expect(html).toContain('value="blaxel"');
  expect(html).toContain("activeProvider = providerSelect.value");
});

test("chat submit locks agent switching while pending without aborting wake creation", () => {
  const html = renderDashboardHtml();

  expect(html).toContain("setSubmitting(true)");
  expect(html).toContain("setSubmitting(false)");
  expect(html).toContain("if (isSubmitting) return;");
  expect(html).toContain("Running chat turn...");
  expect(html).not.toContain("AbortController");
  expect(html).not.toContain("Wake request timed out");
});

test("chat renders assistantMessage and keeps network errors out of transcript", () => {
  const html = renderDashboardHtml();

  expect(html).toContain("body.assistantMessage");
  expect(html).toContain("showNotice");
  expect(html).toContain("Transport error:");
  expect(html).not.toContain('activeMessages().push({ role: "error"');
});

test("chat failed runs show the run error instead of a fake Done assistant message", () => {
  const html = renderDashboardHtml();

  expect(html).toContain('if (body.run?.status === "failed")');
  expect(html).toContain('throw new Error("Run failed: " + (body.run.error || "unknown error"))');
  expect(html).toContain("body.assistantMessage || \"Done.\"");
});
