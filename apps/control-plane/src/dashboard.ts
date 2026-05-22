export function renderDashboardHtml() {
  return String.raw`<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Agent Chat</title>
    <style>
      :root {
        color-scheme: light;
        font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
        background: #eef2f7;
        color: #182235;
      }
      * {
        box-sizing: border-box;
      }
      body {
        margin: 0;
      }
      button,
      select,
      textarea {
        font: inherit;
      }
      main {
        display: grid;
        grid-template-columns: 260px minmax(0, 1fr) minmax(280px, 360px);
        min-height: 100vh;
      }
      aside {
        border-right: 1px solid #cfd8e3;
        background: #ffffff;
        padding: 18px;
      }
      .brand {
        margin-bottom: 18px;
      }
      h1 {
        margin: 0;
        font-size: 22px;
        line-height: 1.2;
        letter-spacing: 0;
      }
      .subtle {
        color: #657386;
        font-size: 13px;
      }
      .agent-list {
        display: grid;
        gap: 8px;
      }
      .provider-control {
        display: grid;
        gap: 6px;
        margin-bottom: 14px;
      }
      .provider-control label {
        color: #58677a;
        font-size: 12px;
        font-weight: 750;
        text-transform: uppercase;
      }
      select {
        width: 100%;
        border: 1px solid #c7d2df;
        border-radius: 8px;
        color: #182235;
        background: #ffffff;
        padding: 9px 10px;
      }
      select:disabled {
        cursor: wait;
        opacity: 0.7;
      }
      .agent-button {
        width: 100%;
        border: 1px solid #d4deea;
        border-radius: 8px;
        background: #f8fafc;
        color: #182235;
        cursor: pointer;
        padding: 11px;
        text-align: left;
      }
      .agent-button.active {
        border-color: #0f766e;
        background: #e8f5f2;
      }
      .agent-button:disabled {
        cursor: wait;
        opacity: 0.7;
      }
      .agent-label {
        display: block;
        font-weight: 750;
      }
      .agent-meta {
        display: block;
        margin-top: 4px;
        overflow-wrap: anywhere;
      }
      .chat {
        display: grid;
        grid-template-rows: auto minmax(0, 1fr) auto;
        min-width: 0;
        background: #f8fafc;
      }
      .chat-header {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 12px;
        border-bottom: 1px solid #d7e0eb;
        background: #ffffff;
        padding: 16px 20px;
      }
      h2 {
        margin: 0;
        font-size: 18px;
        line-height: 1.25;
        letter-spacing: 0;
      }
      .status {
        border: 1px solid #cdd7e4;
        border-radius: 999px;
        color: #285044;
        background: #ffffff;
        font-size: 13px;
        font-weight: 700;
        padding: 6px 10px;
        white-space: nowrap;
      }
      .notice {
        display: none;
        border-bottom: 1px solid #f0c6a2;
        background: #fff7ed;
        color: #8a4b16;
        padding: 10px 20px;
        font-weight: 650;
      }
      .notice.visible {
        display: block;
      }
      .messages {
        display: flex;
        flex-direction: column;
        gap: 12px;
        overflow: auto;
        padding: 20px;
      }
      .empty {
        color: #657386;
        margin: auto;
        max-width: 440px;
        text-align: center;
      }
      .message {
        max-width: min(760px, 88%);
        border: 1px solid #dbe3ee;
        border-radius: 8px;
        background: #ffffff;
        padding: 12px 13px;
        white-space: pre-wrap;
        overflow-wrap: anywhere;
        line-height: 1.45;
      }
      .message.user {
        align-self: flex-end;
        border-color: #b8cee8;
        background: #eaf2fb;
      }
      .message.assistant {
        align-self: flex-start;
      }
      .message.error {
        align-self: flex-start;
        border-color: #efb7b7;
        background: #fff1f1;
        color: #8a2d2d;
      }
      .role {
        display: block;
        margin-bottom: 5px;
        color: #58677a;
        font-size: 12px;
        font-weight: 750;
        text-transform: uppercase;
      }
      form {
        display: grid;
        grid-template-columns: minmax(0, 1fr) 112px;
        gap: 10px;
        border-top: 1px solid #d7e0eb;
        background: #ffffff;
        padding: 14px 20px 18px;
      }
      textarea {
        width: 100%;
        min-height: 46px;
        max-height: 170px;
        resize: vertical;
        border: 1px solid #c7d2df;
        border-radius: 8px;
        color: #182235;
        background: #ffffff;
        padding: 11px 12px;
      }
      .send-button,
      .clear-button {
        border: 0;
        border-radius: 8px;
        cursor: pointer;
        font-weight: 750;
      }
      .send-button {
        color: #ffffff;
        background: #0f766e;
      }
      .send-button:disabled {
        cursor: wait;
        opacity: 0.62;
      }
      .debug {
        border-left: 1px solid #cfd8e3;
        background: #ffffff;
        padding: 18px;
        min-width: 0;
      }
      .debug-header {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 10px;
        margin-bottom: 12px;
      }
      .chat-actions {
        display: flex;
        align-items: center;
        gap: 10px;
      }
      .clear-button {
        color: #2d3a4d;
        background: #e8edf4;
        padding: 8px 10px;
      }
      code {
        background: #eef2f7;
        border-radius: 4px;
        padding: 2px 5px;
      }
      .timings {
        margin-bottom: 12px;
        overflow: auto;
      }
      .timings-empty {
        border: 1px solid #dbe3ee;
        border-radius: 8px;
        color: #657386;
        padding: 10px;
      }
      .timings-table {
        width: 100%;
        border-collapse: collapse;
        font-size: 12px;
      }
      .timings-table th,
      .timings-table td {
        border-bottom: 1px solid #e3eaf2;
        padding: 7px 6px;
        text-align: left;
        white-space: nowrap;
      }
      .timings-table th {
        color: #58677a;
        font-weight: 750;
        text-transform: uppercase;
      }
      .timings-table td:last-child,
      .timings-table th:last-child {
        text-align: right;
      }
      .timings-failed {
        color: #9f2f2f;
        font-weight: 750;
      }
      pre {
        min-height: 320px;
        max-height: calc(100vh - 290px);
        overflow: auto;
        margin: 0;
        padding: 13px;
        border-radius: 8px;
        background: #101828;
        color: #d9e5f5;
        font: 12px/1.5 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
        white-space: pre-wrap;
        word-break: break-word;
      }
      @media (max-width: 980px) {
        main {
          grid-template-columns: 220px minmax(0, 1fr);
        }
        .debug {
          display: none;
        }
      }
      @media (max-width: 720px) {
        main {
          display: block;
        }
        aside {
          border-right: 0;
          border-bottom: 1px solid #cfd8e3;
        }
        .agent-list {
          grid-template-columns: repeat(3, minmax(0, 1fr));
        }
        .chat {
          min-height: calc(100vh - 188px);
        }
        form {
          grid-template-columns: 1fr;
        }
        .send-button {
          min-height: 42px;
        }
      }
    </style>
  </head>
  <body>
    <main>
      <aside>
        <div class="brand">
          <h1>Agent Chat</h1>
          <div class="subtle">Provider-backed agent sessions</div>
        </div>
        <div class="provider-control">
          <label for="provider-select">Provider</label>
          <select id="provider-select">
            <option value="local">Local</option>
            <option value="daytona">Daytona</option>
            <option value="e2b">E2B</option>
            <option value="blaxel">Blaxel</option>
          </select>
        </div>
        <div class="agent-list" id="agent-list"></div>
      </aside>

      <section class="chat">
        <header class="chat-header">
          <div>
            <h2 id="agent-title">Sales</h2>
            <div class="subtle" id="agent-storage">sales-agent / sales-workspace</div>
          </div>
          <div class="chat-actions">
            <div class="status" id="run-status">idle</div>
            <button class="clear-button" id="clear-chat" type="button">Clear</button>
          </div>
        </header>

        <div class="notice" id="notice"></div>
        <div class="messages" id="messages"></div>

        <form id="chat-form">
          <textarea id="message-input" name="message" placeholder="Message this agent" autocomplete="off"></textarea>
          <button class="send-button" type="submit">Send</button>
        </form>
      </section>

      <section class="debug">
        <div class="debug-header">
          <div>
            <h2>Run Events</h2>
            <div class="subtle">Last run: <code id="run-id">none</code></div>
          </div>
        </div>
        <div class="timings" id="timings"><div class="timings-empty">No timings yet.</div></div>
        <pre id="events">No run yet.</pre>
      </section>
    </main>

    <script>
      const agents = [
        { label: "Sales", agentId: "sales-agent", workspaceId: "sales-workspace" },
        { label: "Support", agentId: "support-agent", workspaceId: "support-workspace" },
        { label: "Ops", agentId: "ops-agent", workspaceId: "ops-workspace" },
      ];

      const storageKey = "poc-agent-chat-transcripts-v1";
      const providerStorageKey = "poc-agent-chat-provider-v1";
      const agentListEl = document.querySelector("#agent-list");
      const providerSelect = document.querySelector("#provider-select");
      const agentTitleEl = document.querySelector("#agent-title");
      const agentStorageEl = document.querySelector("#agent-storage");
      const messagesEl = document.querySelector("#messages");
      const noticeEl = document.querySelector("#notice");
      const timingsEl = document.querySelector("#timings");
      const eventsEl = document.querySelector("#events");
      const runIdEl = document.querySelector("#run-id");
      const statusEl = document.querySelector("#run-status");
      const form = document.querySelector("#chat-form");
      const input = document.querySelector("#message-input");
      const sendButton = form.querySelector(".send-button");
      const clearButton = document.querySelector("#clear-chat");

      let activeAgent = agents[0];
      let activeProvider = localStorage.getItem(providerStorageKey) || "local";
      providerSelect.value = activeProvider;
      let transcripts = loadTranscripts();
      let isSubmitting = false;

      function loadTranscripts() {
        try {
          const parsed = JSON.parse(localStorage.getItem(storageKey) || "{}");
          return parsed && typeof parsed === "object" ? parsed : {};
        } catch {
          return {};
        }
      }

      function saveTranscripts() {
        localStorage.setItem(storageKey, JSON.stringify(transcripts));
      }

      function activeMessages() {
        transcripts[activeAgent.agentId] ||= [];
        return transcripts[activeAgent.agentId];
      }

      function renderAgents() {
        agentListEl.textContent = "";
        for (const agent of agents) {
          const button = document.createElement("button");
          button.type = "button";
          button.className = "agent-button" + (agent.agentId === activeAgent.agentId ? " active" : "");
          button.disabled = isSubmitting;
          button.innerHTML = '<span class="agent-label"></span><span class="agent-meta subtle"></span>';
          button.querySelector(".agent-label").textContent = agent.label;
          button.querySelector(".agent-meta").textContent = agent.agentId + " / " + agent.workspaceId;
          button.addEventListener("click", () => {
            if (isSubmitting) return;
            activeAgent = agent;
            resetRunDebug();
            render();
          });
          agentListEl.append(button);
        }
      }

      function renderMessages() {
        messagesEl.textContent = "";
        const messages = activeMessages();
        if (messages.length === 0) {
          const empty = document.createElement("div");
          empty.className = "empty";
          empty.textContent = "Start a conversation. Each message wakes a fresh sandbox with the selected provider and reuses this agent's persisted state.";
          messagesEl.append(empty);
          return;
        }
        for (const message of messages) {
          const item = document.createElement("div");
          item.className = "message " + message.role;
          const role = document.createElement("span");
          role.className = "role";
          role.textContent = message.role;
          const content = document.createElement("span");
          content.textContent = message.content;
          item.append(role, content);
          messagesEl.append(item);
        }
        messagesEl.scrollTop = messagesEl.scrollHeight;
      }

      function render() {
        renderAgents();
        agentTitleEl.textContent = activeAgent.label;
        agentStorageEl.textContent = activeAgent.agentId + " / " + activeAgent.workspaceId;
        renderMessages();
      }

      function resetRunDebug(message = "No run yet.") {
        statusEl.textContent = "idle";
        runIdEl.textContent = "none";
        eventsEl.textContent = message;
        renderTimings([]);
      }

      function renderTimings(events) {
        timingsEl.textContent = "";
        const timings = (events || []).filter((event) => event.type === "phase_timing");
        if (timings.length === 0) {
          const empty = document.createElement("div");
          empty.className = "timings-empty";
          empty.textContent = "No timings yet.";
          timingsEl.append(empty);
          return;
        }

        const table = document.createElement("table");
        table.className = "timings-table";
        const head = document.createElement("thead");
        const headerRow = document.createElement("tr");
        for (const label of ["Phase", "Provider", "Status", "ms"]) {
          const cell = document.createElement("th");
          cell.textContent = label;
          headerRow.append(cell);
        }
        head.append(headerRow);

        const body = document.createElement("tbody");
        for (const timing of timings) {
          const row = document.createElement("tr");
          if (timing.status === "failed") row.className = "timings-failed";
          for (const value of [timing.phase, timing.provider, timing.status, String(timing.durationMs)]) {
            const cell = document.createElement("td");
            cell.textContent = value;
            row.append(cell);
          }
          body.append(row);
        }

        table.append(head, body);
        timingsEl.append(table);
      }

      function renderEvents(value) {
        renderTimings(value?.events || []);
        eventsEl.textContent = JSON.stringify(value, null, 2);
      }

      function showNotice(message) {
        noticeEl.textContent = message;
        noticeEl.classList.add("visible");
      }

      function clearNotice() {
        noticeEl.textContent = "";
        noticeEl.classList.remove("visible");
      }

      function setSubmitting(value) {
        isSubmitting = value;
        sendButton.disabled = value;
        input.disabled = value;
        providerSelect.disabled = value;
        for (const button of agentListEl.querySelectorAll(".agent-button")) {
          button.disabled = value;
        }
      }

      function buildWakeMessage(userText) {
        const previous = activeMessages()
          .slice(-12)
          .map((message) => message.role.toUpperCase() + ": " + message.content)
          .join("\n\n");
        return [
          "Conversation so far:",
          previous || "(no previous turns)",
          "",
          "Current user message:",
          userText,
          "",
          "Reply conversationally to the current user message. Use the persisted /agent-home and /workspace state when it helps.",
        ].join("\n");
      }

      form.addEventListener("submit", async (event) => {
        event.preventDefault();
        if (isSubmitting) return;
        const userText = input.value.trim();
        if (!userText) return;

        const requestAgent = activeAgent;
        const messages = activeMessages();
        const wakeMessage = buildWakeMessage(userText);
        clearNotice();
        messages.push({ role: "user", content: userText });
        saveTranscripts();
        input.value = "";
        renderMessages();

        setSubmitting(true);
        statusEl.textContent = "running";
        renderTimings([]);
        eventsEl.textContent = "Running chat turn...";

        try {
          const response = await fetch("/chat-turn", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              source: "chat",
              agentId: requestAgent.agentId,
              workspaceId: requestAgent.workspaceId,
              sandboxProvider: activeProvider,
              message: wakeMessage,
              conversationId: requestAgent.agentId,
              metadata: {
                ui: "agent-chat",
                userMessage: userText,
              },
            }),
          });
          const body = await response.json();
          if (!response.ok) throw new Error(body.error || "chat turn failed");
          runIdEl.textContent = body.run.id;
          statusEl.textContent = body.run.status || "unknown";
          renderEvents({ events: body.events });
          if (body.run?.status === "failed") {
            throw new Error("Run failed: " + (body.run.error || "unknown error"));
          }
          activeMessages().push({ role: "assistant", content: body.assistantMessage || "Done." });
          saveTranscripts();
          renderMessages();
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          showNotice("Transport error: " + message);
          statusEl.textContent = "error";
        } finally {
          setSubmitting(false);
          input.focus();
        }
      });

      clearButton.addEventListener("click", () => {
        transcripts[activeAgent.agentId] = [];
        saveTranscripts();
        renderMessages();
      });

      providerSelect.addEventListener("change", () => {
        if (isSubmitting) {
          providerSelect.value = activeProvider;
          return;
        }
        activeProvider = providerSelect.value;
        localStorage.setItem(providerStorageKey, activeProvider);
        resetRunDebug();
      });

      input.addEventListener("keydown", (event) => {
        if (event.key === "Enter" && !event.shiftKey) {
          event.preventDefault();
          form.requestSubmit();
        }
      });

      render();
    </script>
  </body>
</html>`;
}
