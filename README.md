# Ephemeral Agent Sandbox PoC

TypeScript PoC for a control plane that wakes an agent runtime, materializes `/agent-home`, `/workspace`, and shared runtime files, executes the runtime through a sandbox provider, and records typed run events.

## Local Provider

The local provider does not create a microVM. It proves the lifecycle on this machine.

```bash
pnpm install
PORT=3777 CONTROL_PLANE_URL=http://localhost:3777 pnpm dev
```

Open:

```text
http://localhost:3777
```

Run the CLI demo:

```bash
CONTROL_PLANE_URL=http://localhost:3777 pnpm wake:demo
```

## Chat Dashboard

The browser dashboard is a three-agent chat harness over `POST /chat-turn`.
Each message creates one run, and with Daytona enabled that means one ephemeral sandbox per message. The selected agent's Daytona volume subpaths are reused across turns:

```text
Sales   -> agents/sales-agent   and workspaces/sales-workspace
Support -> agents/support-agent and workspaces/support-workspace
Ops     -> agents/ops-agent     and workspaces/ops-workspace
```

The browser keeps a per-agent transcript in `localStorage` and sends recent prior turns with each wake message, so you can run a multi-turn manual conversation while the durable agent/workspace state remains in Daytona volumes.

To expose it publicly for manual testing:

```bash
PORT=3777 CONTROL_PLANE_URL=https://your-ngrok-url.ngrok-free.app pnpm dev
ngrok http 3777
```

## Daytona Provider

The Daytona provider creates an ephemeral Daytona sandbox, mounts one persistent Daytona volume at separate subpaths for `/agent-home` and `/workspace`, uploads the shared runtime bundle and harness, executes the runtime, follows Daytona session logs to stream JSONL events back to the control plane when the SDK supports it, and deletes the sandbox. It keeps a buffered `executeCommand` fallback for older/fake providers.

Required auth is either `DAYTONA_API_KEY` or both `DAYTONA_JWT_TOKEN` and `DAYTONA_ORGANIZATION_ID`.
For API-key auth, no organization id is needed in this PoC path; the key itself must have enough Daytona scopes.
The persistence smoke needs at least sandbox create/delete access plus volume read/write access:

```text
write:sandboxes
delete:sandboxes
read:volumes
write:volumes
```

```bash
export DAYTONA_API_KEY=...
# or:
export DAYTONA_JWT_TOKEN=...
export DAYTONA_ORGANIZATION_ID=...
export SANDBOX_PROVIDER=daytona
export DAYTONA_VOLUME_NAME=poc-ephemeral-agent-sandbox
export DAYTONA_IMAGE=node:22-bookworm
export DAYTONA_TARGET=eu
```

Optional:

```bash
export DAYTONA_API_URL=...
export DAYTONA_TARGET=...
export DAYTONA_SNAPSHOT=...
export DAYTONA_COMMAND_TIMEOUT_SEC=900
```

Run:

```bash
PORT=3777 CONTROL_PLANE_URL=http://localhost:3777 pnpm dev
```

Then use the browser dashboard or:

```bash
CONTROL_PLANE_URL=http://localhost:3777 pnpm wake:demo
```

## Agent Runtime Modes

The control plane supports two runtime modes:

```bash
export AGENT_RUNTIME_MODE=mock
```

`mock` is the deterministic default. It proves the wake/run/event/filesystem lifecycle without calling an LLM.

```bash
export AGENT_RUNTIME_MODE=pi
export PI_MODEL=openai/gpt-5.5
export PI_THINKING_LEVEL=medium
export OPENAI_API_KEY=...
```

`pi` uploads a Pi coding-agent runner into the Daytona sandbox, installs `@earendil-works/pi-coding-agent` in `/agentruntime/harness`, runs Pi with cwd `/workspace`, stores Pi auth/session files under `/agent-home/pi`, and passes provider API keys such as `OPENAI_API_KEY` into the sandbox command.

For faster startup, use a Daytona snapshot with Node and Pi dependencies preinstalled. Without a prebuilt snapshot, the PoC installs Pi dependencies inside each ephemeral sandbox run.

Create the snapshot:

```bash
export DAYTONA_PI_SNAPSHOT_NAME=poc-pi-runner
pnpm snapshot:daytona:pi
```

Use it:

```bash
export DAYTONA_SNAPSHOT=poc-pi-runner
export PI_INSTALL_DEPS=false
```

Run the real Daytona/Pi persistence smoke test:

```bash
export DAYTONA_API_KEY=...
# or export DAYTONA_JWT_TOKEN=... and DAYTONA_ORGANIZATION_ID=...
export OPENAI_API_KEY=...
SANDBOX_PROVIDER=daytona AGENT_RUNTIME_MODE=pi pnpm smoke:daytona:pi
```

The smoke script also reads `.env.local` and `.env` from the repo root without overriding exported environment variables. `.env.local` has precedence over `.env`.

The smoke test performs two separate Pi-backed Daytona wakes for the same `agentId` and `workspaceId`, stops each ephemeral sandbox, then starts an inspection sandbox with the same persistent volume subpaths mounted. It verifies that both run notes exist under `/workspace/notes`, both run IDs were appended to `/agent-home/MEMORY.md`, and Pi session storage exists under `/agent-home/pi/sessions`.

## Disk Model

Inside the runtime:

```text
/agent-home          persistent per-agent state
/workspace           persistent per-workspace/project state
/agentruntime/shared projected shared bundle for this run
/run                 wake payload and scratch
```

For Daytona, `/agent-home` and `/workspace` are mounted from the same persistent volume:

```text
agents/{agentId}       -> /agent-home
workspaces/{workspaceId} -> /workspace
```

## Validation

```bash
pnpm test
pnpm typecheck
```
