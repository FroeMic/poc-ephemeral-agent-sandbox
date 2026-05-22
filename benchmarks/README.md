# Benchmark Experiments

This directory is the experiment surface for comparing sandbox providers, runtimes, storage modes, and lifecycle strategies.

## Concepts

- **Scenario**: one provider/runtime/storage/lifecycle configuration plus a workload.
- **Matrix**: an ordered list of scenario files to run as a batch.
- **Result**: raw samples and summary metrics written to `benchmarks/results/`.

Scenario dimensions are intentionally generic so new experiments fit without changing the runner:

```text
provider: local | daytona | e2b | blaxel
runtime: mock | pi | future runtimes
lifecycle: create-delete | pause-resume | snapshot-clone | warm-pool | standby
storage.mode: ephemeral | provider-volume | archil | s3fs | local-filesystem
image.prebuild: install/runtime/template steps baked before benchmark time
```

## Commands

Run one scenario:

```bash
pnpm bench:scenario benchmarks/scenarios/local-mock.json
```

Run a matrix:

```bash
pnpm bench:matrix benchmarks/matrix-provider-smoke.json
```

Override output location:

```bash
BENCH_RESULTS_DIR=benchmarks/results pnpm bench:scenario benchmarks/scenarios/local-mock.json
```

Keep temporary local data for inspection:

```bash
BENCH_KEEP_DATA=true pnpm bench:scenario benchmarks/scenarios/local-mock.json
```

## Auto-Research Shape

An auto-research loop should propose one scenario change at a time, run the scenario or matrix, compare the result against a baseline, and keep only changes that improve the target metric without increasing failures.

Good first objectives:

```text
Minimize p95 totalMs for Blaxel Pi baked image.
Minimize sandbox_acquire once phase timing is added.
Compare E2B Archil create-delete vs pause-resume.
Compare runtime_prepare cost for small vs full shared bundles.
```

## Timing Model

Every chat turn now records shared `phase_timing` events:

```text
local_materialize: control plane creates the local run filesystem.
sandbox_acquire: provider allocates or resumes the sandbox.
runtime_execute: the agent runtime command runs inside the sandbox.
sandbox_release: provider stop/delete/pause cleanup.
total_run: end-to-end control-plane run time.
```

Scenario results store each sample's raw `phaseTimings` and a `summary.phaseTimings` distribution grouped by phase. Provider-internal subphases can be added as more scenarios need them, for example `storage_attach`, `dependency_install`, `template_start`, or `warm_pool_checkout`.
