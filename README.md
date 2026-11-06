# superagent

A self-hosted super-agent for a single operator. Requests from chat, email, or the
CLI become **tickets**; each ticket runs in an isolated Linux sandbox with a coding
agent, passes through policy and budget checks, and reports its result back to where
the request came from.

Status: early (0.1.0), Linux + rootless Podman. Not multi-tenant.

## What it does

- **Sources** — Feishu (WebSocket long connection), Gmail (IMAP/SMTP), and the `sa`
  CLI. Accepted messages are deduplicated by trigger, gated by per-source allow
  lists, and optionally screened by a model assessor.
- **Ticket kernel** — the domain model (Source → Trigger → Thread → Eval → Mandate →
  Ticket → Assignment → Report) is ported from the MIT-licensed
  [`dsh-superagent-prototype`](https://github.com/deepseek-ai/dsh-superagent-prototype);
  the runtime, executor, sources, and console are implemented here.
- **Sandboxed execution** — each assignment gets a fresh workspace and a rootless
  Podman container running the Pi coding agent in RPC mode. Concurrency is capped by
  `maxSlots`; container filesystem, network, and process limits live in
  `deploy/pi-container.sh`.
- **Model gateway** — providers and models are configured in the console. Workers
  call the gateway with a per-ticket bearer token, never an upstream key. The gateway
  records pricing, token usage, and cache hits; exhausted budgets return 402.
- **Admin console** — a static single-page app (no build step) at
  `127.0.0.1:8787`: tickets, projects, council, secrets, settings, usage, events,
  and system/backup operations.
- **Projects** — upload a ZIP, extract it safely, build a project profile, and read
  the worker's deliverables in the console.
- **Council** — five review seats (requirements, architecture, implementation,
  testing, risk) plus a moderator, optionally backed by different models.
- **Durable plumbing** — SQLite WAL ledger, effects/outbox queues, idempotent
  triggers, encrypted secret vault (AES-256-GCM), and secret redaction on outbound
  text.

## Requirements

- Node.js 22.19+ (uses `node:sqlite`) and pnpm 10.
- Linux with rootless Podman for real sandboxed workers; a fake launcher is included
  for local development.
- Pi CLI 1.5.x. The version is pinned because the RPC protocol is not stable.

## Quick start

```sh
pnpm install
pnpm check                 # typecheck + vitest
```

Run the daemon with the local fake worker and ask it something:

```sh
node --experimental-transform-types src/daemon.ts --config examples/config.local.json
node --experimental-transform-types src/cli/sa.ts ask "list the files here" --wait
```

For a real deployment (rootless Podman, systemd, model keys), follow
[`deploy/README.md`](deploy/README.md).

## Configuration

`examples/config.local.json` is the development config; `examples/config.debian.json`
is the deployment shape. The upstream model key is never written to a config file —
the config only names the environment variable that holds it
(`deepseekApiKeyEnv`, default `DEEPSEEK_API_KEY`).

Runtime state (`stateDir`) contains the SQLite database, vault, admin settings, the
CLI token, and per-ticket Pi configs. It is created outside the repository and is
gitignored.

## Security model

- **Per-ticket credentials.** Each ticket gets a random token valid only for its
  gateway and MCP endpoints; the token dies with the assignment.
- **Sandbox boundary.** Rootless Podman, read-only root filesystem, `no-new-privileges`,
  a PID limit, and only the two required loopback ports forwarded into the container.
- **Secret handling.** Values are encrypted at rest with AES-256-GCM (master key from
  `SA_VAULT_KEY` or `state/vault.key`) and are never returned by a public view, event,
  log, or error.
- **Console exposure.** The admin server binds `127.0.0.1`. Put a reverse proxy or a
  private network (for example Tailscale) in front of it; the control and admin ports
  must not be exposed directly.
- **Policy in code.** Admission, authorization, budgets, and dangerous-action rules
  are enforced by the kernel, not by prompts.

## Layout

| Path | Purpose |
| --- | --- |
| `src/core/` | Ported domain kernel: tickets, assignments, policy, evals, memory |
| `src/runtime.ts` | Wires sources, engine, gateway, executor, MCP, admin, and outbox |
| `src/admin/` | Admin HTTP API, auth, vault, backups, projects, console UI |
| `src/admin/web/` | Static admin console (HTML/CSS/JS, no build step) |
| `src/gateway/` | Per-ticket model gateway, pricing, usage |
| `src/executor/` | Pi RPC launcher and model config generation |
| `src/mcp/` | MCP tools exposed to the worker |
| `src/sources/` | Feishu, Gmail, CLI sources |
| `src/council/` | Five-seat review council |
| `src/projects/` | Project upload, extraction, profile, deliverables |
| `deploy/` | Containerfile, Podman launcher, systemd unit, runbook |
| `tests/` | Vitest suite (kernel, policy, gateway, sources, admin, web) |

## Testing

```sh
pnpm typecheck
pnpm test
```

## License

Apache-2.0; see [`LICENSE`](LICENSE). The ported kernel files remain under the MIT
license — see [`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md).
