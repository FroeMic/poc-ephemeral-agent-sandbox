const baseUrl = process.env.CONTROL_PLANE_URL ?? "http://localhost:3000";

const response = await fetch(`${baseUrl}/wake`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({
    source: "api",
    agentId: "agent-main",
    workspaceId: "workspace-demo",
    message: `Create a durable PoC note at ${new Date().toISOString()}`,
  }),
});

if (!response.ok) {
  throw new Error(`Wake failed: ${response.status} ${await response.text()}`);
}

const body = (await response.json()) as { runId: string; eventStreamUrl: string };
process.stdout.write(`Created run ${body.runId}\n`);

let final = "";
for (let attempt = 0; attempt < 50; attempt += 1) {
  await new Promise((resolve) => setTimeout(resolve, 200));
  const runResponse = await fetch(`${baseUrl}/runs/${body.runId}`);
  const run = (await runResponse.json()) as { status?: string };
  final = run.status ?? "";
  if (final === "succeeded" || final === "failed") break;
}

const events = await fetch(`${baseUrl}${body.eventStreamUrl}`).then((res) => res.json());
process.stdout.write(`${JSON.stringify({ runId: body.runId, status: final, events }, null, 2)}\n`);
