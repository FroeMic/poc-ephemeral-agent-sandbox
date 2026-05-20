import { expect, test } from "vitest";
import { renderDashboardHtml } from "../apps/control-plane/src/dashboard.js";

test("renders a browser dashboard that can create wakes and inspect events", () => {
  const html = renderDashboardHtml();

  expect(html).toContain("<!doctype html>");
  expect(html).toContain("Ephemeral Sandbox Control Plane");
  expect(html).toContain("POST /wake");
  expect(html).toContain("fetch(\"/wake\"");
  expect(html).toContain('fetch("/runs/" + runId + "/events")');
});
