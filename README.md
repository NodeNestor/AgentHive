# AgentHive

Persistent AI agents triggered by GitHub events. You write YAML
workflow files in your repo; AgentHive spawns long-lived Claude
Code containers that loop until the job is done.

> Status: WIP. First end-to-end test pending.

## Parts

- **Router** (`src/`) — Node/TypeScript. Receives GitHub webhooks,
  routes to agent containers by `<repo>/<workflow>/<scope>`.
- **Agents** — YAML files in each repo at
  `.agents/workflows/*.yml`. No built-in agents; the router has
  zero opinions about what they do.
- **Containers** — [AgentCore](https://github.com/NodeNestor/AgentCore)
  (Claude Code + Playwright + control API). One per active scope,
  persistent across events.

## Server setup

```bash
git clone https://github.com/NodeNestor/AgentHive.git
cd AgentHive
cp .env.example .env
# set WEBHOOK_SECRET, DISPATCH_TOKEN, GITHUB_TOKEN.
docker network create agenthive-net
docker compose up -d
```

Claude auth is auto-detected from host `~/.claude` (Linux/macOS,
or Windows Docker Desktop — paths auto-translated). Fallback:
`ANTHROPIC_API_KEY`.

## Repo setup

In each repo you want agents on:

1. Commit `examples/consumer/ai.yml` → `.github/workflows/ai.yml`.
2. Commit any of `examples/workflows/*.yml` → `.agents/workflows/<name>.yml`.
3. Add repo Variable `AGENTHIVE_URL` + Secret `AGENTHIVE_SECRET`
   (matches the server's `WEBHOOK_SECRET`).

## Layout

```
AgentHive/
├── .github/actions/dispatch/    # composite action consumers use
├── examples/
│   ├── consumer/ai.yml          # consumer workflow snippet
│   └── workflows/               # reference agent definitions
├── hooks-lib/lib.sh             # shared bash mounted into containers
├── src/                         # router
├── docker-compose.yml
└── Dockerfile
```

See `CLAUDE.md` for per-file notes.

MIT.
