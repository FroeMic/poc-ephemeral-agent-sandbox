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

## E2B Provider

The E2B provider uses the same runtime harness as Daytona. It creates one E2B sandbox per run, uploads the shared runtime bundle, executes the harness with `commands.run()`, and kills the sandbox after the turn.

E2B volumes are currently private beta. If your E2B account does not have volume access yet, sandbox creation will fail at the volume step.

```bash
export SANDBOX_PROVIDER=e2b
export E2B_API_KEY=...
export E2B_TEMPLATE=base
export E2B_VOLUME_PREFIX=poc-e2b
export E2B_COMMAND_TIMEOUT_SEC=900
```

For initial provider smoke tests without E2B volumes:

```bash
export E2B_STORAGE_MODE=ephemeral
export E2B_USE_VOLUMES=false
```

For Archil-backed storage, create or select an E2B template with the `archil` CLI installed first. The E2B Archil docs show a template based on `code-interpreter-v1` with `libfuse2` and `ca-certificates` installed, followed by:

```bash
curl -fsSL https://archil.com/install | sh
```

This repo includes a build script that uses E2B's Node 22 base image by default, installs Archil, preinstalls Pi dependencies into `/tmp/agentruntime/harness`, then writes the successful template name back to `.env` and disables per-run Pi dependency installation:

```bash
pnpm template:e2b:pi-archil
```

Override the base only if needed:

```bash
export E2B_PI_ARCHIL_NODE_VARIANT=22
# or:
export E2B_PI_ARCHIL_BASE_TEMPLATE=your-existing-template
```

Then configure:

```bash
export E2B_STORAGE_MODE=archil
export E2B_USE_VOLUMES=false
export E2B_TEMPLATE=poc-pi-archil
export E2B_ARCHIL_MOUNT_TOKEN=...
export E2B_ARCHIL_DISK=michael@interaction42.com/poc-test
export E2B_ARCHIL_REGION=aws-eu-west-1
export E2B_ARCHIL_MOUNT_PATH=/home/user/archil
export PI_INSTALL_DEPS=false
```

In Archil mode, the provider mounts the disk before preparing the runtime, uses `/home/user/archil/agent-home` and `/home/user/archil/workspace` for durable state, and unmounts Archil before killing the sandbox.

## Blaxel Provider

The Blaxel provider also uses the shared runtime harness. It creates one Blaxel volume per agent/workspace pair, attaches it at `/persistent`, symlinks `/agent-home` and `/workspace` into that volume, runs the harness with `process.exec()`, and deletes the sandbox after the turn.

Blaxel SDK authentication is environment-based:

```bash
export SANDBOX_PROVIDER=blaxel
export BL_API_KEY=...
export BL_WORKSPACE=...
export BLAXEL_REGION=us-pdx-1
export BLAXEL_IMAGE=blaxel/base-image:latest
export BLAXEL_VOLUME_PREFIX=poc-blaxel
export BLAXEL_MEMORY_MB=4096
export BLAXEL_COMMAND_TIMEOUT_SEC=900
```

Blaxel uses `BLAXEL_PI_INSTALL_DEPS=true` by default when `AGENT_RUNTIME_MODE=pi`, even if `PI_INSTALL_DEPS=false` is set for an E2B or Daytona baked template. Set `BLAXEL_PI_INSTALL_DEPS=false` only when `BLAXEL_IMAGE` already contains `/agentruntime/harness/node_modules`.

This repo includes a Blaxel sandbox image that bakes the Pi dependency into `/agentruntime/harness/node_modules`, so each turn can skip `npm install --omit=dev`:

```bash
brew tap blaxel-ai/blaxel
brew install blaxel
pnpm image:blaxel:pi
```

The build script stages `infra/blaxel/pi-sandbox` into `/tmp`, pushes it as `poc-pi-runner-real-template` by default, then updates `.env` with:

```bash
BLAXEL_IMAGE=sandbox/poc-pi-runner-real-template:latest
BLAXEL_PI_INSTALL_DEPS=false
```

Override the build name or timeout if needed:

```bash
export BLAXEL_PI_IMAGE_NAME=poc-pi-runner-real-template
export BLAXEL_PI_IMAGE_TIMEOUT=30m
```

## Benchmarking Providers

Use the same benchmark command for every provider. It reads `.env`, runs `BENCH_TURNS` sequential chat turns through `POST /chat-turn` semantics, and prints per-turn JSON plus a min/p50/p90/max summary.

```bash
SANDBOX_PROVIDER=daytona AGENT_RUNTIME_MODE=mock BENCH_TURNS=3 pnpm bench:chat
SANDBOX_PROVIDER=e2b AGENT_RUNTIME_MODE=mock BENCH_TURNS=3 pnpm bench:chat
SANDBOX_PROVIDER=blaxel AGENT_RUNTIME_MODE=mock BENCH_TURNS=3 pnpm bench:chat
```

For Pi runtime benchmarks, export the provider credentials plus model credentials:

```bash
export AGENT_RUNTIME_MODE=pi
export PI_MODEL=openai/gpt-4o-mini
export PI_THINKING_LEVEL=low
export OPENAI_API_KEY=...
BENCH_TURNS=3 pnpm bench:chat
```

Useful benchmark knobs:

```bash
export BENCH_AGENT_ID=bench-agent
export BENCH_WORKSPACE_ID=bench-workspace
export BENCH_MESSAGE="Remember this turn and reply in one short sentence."
export BENCH_KEEP_DATA=true
```

For repeatable experiments, prefer scenario files under `benchmarks/scenarios/`:

```bash
pnpm bench:scenario benchmarks/scenarios/local-mock.json
pnpm bench:matrix benchmarks/matrix-provider-smoke.json
```

Scenario results are written to `benchmarks/results/` and include provider, runtime, storage, lifecycle, image/prebuild metadata, samples, and summaries. See `benchmarks/README.md`.

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

The smoke script also reads `.env` from the repo root without overriding exported environment variables.

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
