# Blaxel Scratch Sandbox

A basic Blaxel sandbox with a Next.js workspace and the sandbox API.

## Quick Start

```bash
bl new sandbox my-sandbox -t scratch -y
cd my-sandbox
bl deploy
bl connect sandbox my-sandbox
```

## Local Docker

```bash
make build
make run
```

## Project Files

- `Dockerfile` builds the sandbox image.
- `entrypoint.sh` starts the Blaxel sandbox API and the Next.js dev server.
- `blaxel.toml` configures the Blaxel sandbox runtime.
