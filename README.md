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

## Daytona Provider

The Daytona provider creates an ephemeral Daytona sandbox, mounts one persistent Daytona volume at separate subpaths for `/agent-home` and `/workspace`, uploads the shared runtime bundle and harness, executes the runtime, parses JSONL events, and deletes the sandbox.

Required:

```bash
export DAYTONA_API_KEY=...
export SANDBOX_PROVIDER=daytona
export DAYTONA_VOLUME_NAME=poc-ephemeral-agent-sandbox
export DAYTONA_IMAGE=node:22-bookworm
```

Optional:

```bash
export DAYTONA_API_URL=...
export DAYTONA_TARGET=...
export DAYTONA_SNAPSHOT=...
```

Run:

```bash
PORT=3777 CONTROL_PLANE_URL=http://localhost:3777 pnpm dev
```

Then use the browser dashboard or:

```bash
CONTROL_PLANE_URL=http://localhost:3777 pnpm wake:demo
```

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
