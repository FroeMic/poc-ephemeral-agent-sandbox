import http from "node:http";
import path from "node:path";
import { JsonStore } from "./db/store.js";
import { loadDotEnvFiles, readConfig } from "./config.js";
import { renderDashboardHtml } from "./dashboard.js";
import { createSandboxProvider } from "./provider.js";
import { createRunService } from "./services/run-service.js";

async function readBody(req: http.IncomingMessage) {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  const raw = Buffer.concat(chunks).toString("utf8");
  return raw ? JSON.parse(raw) : {};
}

function sendJson(res: http.ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(`${JSON.stringify(body, null, 2)}\n`);
}

function sendHtml(res: http.ServerResponse, status: number, body: string) {
  res.writeHead(status, { "content-type": "text/html; charset=utf-8" });
  res.end(body);
}

export async function createServer() {
  await loadDotEnvFiles();
  const config = readConfig();
  const store = await JsonStore.create(path.join(config.dataDir, "store.json"));
  const runService = createRunService({
    repoRoot: config.repoRoot,
    dataDir: config.dataDir,
    controlPlaneUrl: config.controlPlaneUrl,
    sharedBundleVersion: config.sharedBundleVersion,
    provider: createSandboxProvider({
      sandboxProvider: config.sandboxProvider,
      repoRoot: config.repoRoot,
      agentRuntime: config.agentRuntime,
      daytona: config.daytona,
      e2b: config.e2b,
      blaxel: config.blaxel,
    }),
    createProvider: (sandboxProvider) =>
      createSandboxProvider({
        sandboxProvider,
        repoRoot: config.repoRoot,
        agentRuntime: config.agentRuntime,
        daytona: config.daytona,
        e2b: config.e2b,
        blaxel: config.blaxel,
      }),
    store,
  });

  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? "/", "http://localhost");
      if (req.method === "GET" && url.pathname === "/") {
        sendHtml(res, 200, renderDashboardHtml());
        return;
      }
      if (req.method === "GET" && url.pathname === "/api") {
        sendJson(res, 200, {
          name: "poc-ephemeral-agent-sandbox",
          routes: ["POST /wake", "POST /chat-turn", "GET /runs/:runId", "GET /runs/:runId/events", "GET /tasks"],
        });
        return;
      }
      if (req.method === "POST" && url.pathname === "/wake") {
        sendJson(res, 202, await runService.wake(await readBody(req)));
        return;
      }
      if (req.method === "POST" && url.pathname === "/chat-turn") {
        sendJson(res, 200, await runService.chatTurn(await readBody(req)));
        return;
      }
      const runMatch = url.pathname.match(/^\/runs\/([^/]+)$/);
      if (req.method === "GET" && runMatch?.[1]) {
        const run = runService.getRun(runMatch[1]);
        sendJson(res, run ? 200 : 404, run ?? { error: "run_not_found" });
        return;
      }
      const eventsMatch = url.pathname.match(/^\/runs\/([^/]+)\/events$/);
      if (req.method === "GET" && eventsMatch?.[1]) {
        sendJson(res, 200, { events: runService.listRunEvents(eventsMatch[1]) });
        return;
      }
      if (req.method === "GET" && url.pathname === "/tasks") {
        sendJson(res, 200, { tasks: runService.listTasks() });
        return;
      }
      sendJson(res, 404, { error: "not_found" });
    } catch (error) {
      sendJson(res, 500, { error: error instanceof Error ? error.message : String(error) });
    }
  });

  return { server, config };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const { server, config } = await createServer();
  server.listen(config.port, "127.0.0.1", () => {
    process.stdout.write(`control-plane listening on http://127.0.0.1:${config.port}\n`);
  });
}
