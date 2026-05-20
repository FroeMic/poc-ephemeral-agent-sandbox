export function renderDashboardHtml() {
  return String.raw`<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Ephemeral Sandbox Control Plane</title>
    <style>
      :root {
        color-scheme: light;
        font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
        background: #f5f7fb;
        color: #172033;
      }
      * {
        box-sizing: border-box;
      }
      body {
        margin: 0;
      }
      main {
        max-width: 1120px;
        margin: 0 auto;
        padding: 32px 20px;
      }
      header {
        display: flex;
        align-items: end;
        justify-content: space-between;
        gap: 16px;
        margin-bottom: 24px;
      }
      h1 {
        margin: 0;
        font-size: 30px;
        line-height: 1.15;
        letter-spacing: 0;
      }
      p {
        margin: 8px 0 0;
        color: #526071;
      }
      .status {
        border: 1px solid #cfd8e3;
        border-radius: 8px;
        padding: 10px 12px;
        background: #ffffff;
        color: #286148;
        font-weight: 650;
      }
      .grid {
        display: grid;
        grid-template-columns: minmax(280px, 380px) 1fr;
        gap: 20px;
      }
      section {
        min-width: 0;
      }
      form,
      .panel {
        background: #ffffff;
        border: 1px solid #d8e0ea;
        border-radius: 8px;
        padding: 18px;
      }
      label {
        display: grid;
        gap: 6px;
        margin-bottom: 14px;
        font-size: 13px;
        font-weight: 650;
        color: #38465a;
      }
      input,
      textarea {
        width: 100%;
        border: 1px solid #cbd5e1;
        border-radius: 6px;
        padding: 10px 11px;
        font: inherit;
        color: #172033;
        background: #ffffff;
      }
      textarea {
        min-height: 112px;
        resize: vertical;
      }
      button {
        width: 100%;
        border: 0;
        border-radius: 6px;
        padding: 11px 12px;
        background: #1d4f91;
        color: #ffffff;
        font: inherit;
        font-weight: 700;
        cursor: pointer;
      }
      button:disabled {
        opacity: 0.6;
        cursor: wait;
      }
      h2 {
        margin: 0 0 12px;
        font-size: 17px;
        letter-spacing: 0;
      }
      code {
        background: #eef2f7;
        border-radius: 4px;
        padding: 2px 5px;
      }
      pre {
        min-height: 420px;
        max-height: 68vh;
        overflow: auto;
        margin: 0;
        padding: 14px;
        border-radius: 6px;
        background: #101828;
        color: #d7e3f4;
        font: 13px/1.5 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
        white-space: pre-wrap;
        word-break: break-word;
      }
      .meta {
        display: flex;
        gap: 10px;
        flex-wrap: wrap;
        margin-bottom: 12px;
        color: #526071;
        font-size: 13px;
      }
      @media (max-width: 760px) {
        header,
        .grid {
          display: block;
        }
        .status {
          margin-top: 14px;
        }
        form {
          margin-bottom: 20px;
        }
      }
    </style>
  </head>
  <body>
    <main>
      <header>
        <div>
          <h1>Ephemeral Sandbox Control Plane</h1>
          <p>Trigger a local sandbox run, persist workspace state, and inspect typed run events.</p>
        </div>
        <div class="status">local provider online</div>
      </header>

      <div class="grid">
        <section>
          <form id="wake-form">
            <h2>Create Wake</h2>
            <label>
              Agent ID
              <input name="agentId" value="agent-main" autocomplete="off" />
            </label>
            <label>
              Workspace ID
              <input name="workspaceId" value="workspace-demo" autocomplete="off" />
            </label>
            <label>
              Message
              <textarea name="message">Create a durable note from the browser dashboard.</textarea>
            </label>
            <button type="submit">POST /wake</button>
          </form>
        </section>

        <section class="panel">
          <h2>Run Events</h2>
          <div class="meta">
            <span>Last run: <code id="run-id">none</code></span>
            <span>Status: <code id="run-status">idle</code></span>
          </div>
          <pre id="events">No run yet.</pre>
        </section>
      </div>
    </main>

    <script>
      const form = document.querySelector("#wake-form");
      const eventsEl = document.querySelector("#events");
      const runIdEl = document.querySelector("#run-id");
      const statusEl = document.querySelector("#run-status");
      const button = form.querySelector("button");

      function render(value) {
        eventsEl.textContent = JSON.stringify(value, null, 2);
      }

      async function pollRun(runId, eventStreamUrl) {
        for (let attempt = 0; attempt < 80; attempt += 1) {
          const [runResponse, eventsResponse] = await Promise.all([
            fetch("/runs/" + runId),
            fetch("/runs/" + runId + "/events"),
          ]);
          const run = await runResponse.json();
          const events = await eventsResponse.json();
          statusEl.textContent = run.status || "unknown";
          render(events);
          if (run.status === "succeeded" || run.status === "failed" || run.status === "cancelled") return;
          await new Promise((resolve) => setTimeout(resolve, 250));
        }
        const eventsResponse = await fetch(eventStreamUrl);
        render(await eventsResponse.json());
      }

      form.addEventListener("submit", async (event) => {
        event.preventDefault();
        button.disabled = true;
        statusEl.textContent = "submitting";
        eventsEl.textContent = "Creating wake...";
        try {
          const formData = new FormData(form);
          const response = await fetch("/wake", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              source: "api",
              agentId: String(formData.get("agentId")),
              workspaceId: String(formData.get("workspaceId")),
              message: String(formData.get("message")),
            }),
          });
          const body = await response.json();
          if (!response.ok) throw new Error(body.error || "wake failed");
          runIdEl.textContent = body.runId;
          await pollRun(body.runId, body.eventStreamUrl);
        } catch (error) {
          statusEl.textContent = "error";
          render({ error: error instanceof Error ? error.message : String(error) });
        } finally {
          button.disabled = false;
        }
      });
    </script>
  </body>
</html>`;
}
