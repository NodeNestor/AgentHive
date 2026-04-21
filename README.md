# AgentHive

> ## ⚠️ Work in progress — not tested end-to-end yet
>
> The architecture and code compile and boot, but the full
> GitHub → router → AgentCore → agent-works-on-a-real-PR
> path has not been run against a live repo yet. Prompts,
> stop-hook semantics, and container spawn details may still
> change. Don't rely on this for anything important.

Persistent AI agents triggered by GitHub events. You write YAML
workflow files in your repo; AgentHive spawns long-lived Claude
Code containers that loop until the job is done.

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

## Access control

Defense-in-depth against stranger abuse — especially relevant for
public repos:

- **Webhook endpoint** — HMAC-SHA256 verified. Only GitHub (or
  someone with `WEBHOOK_SECRET`) can POST.
- **Admin endpoints** (`/dispatch`, `/sessions/*`, etc.) — bearer
  `DISPATCH_TOKEN` required.
- **Workflow definitions** — fetched from the default branch only,
  never from a PR's head. A hostile PR adding a new
  `.agents/workflows/*.yml` has no effect until merged (and merging
  is GitHub's permission system, not ours).
- **Slash commands** — by default require commenter's
  `author_association` to be OWNER / MEMBER / COLLABORATOR.
  Non-collaborators posting `/ai code ...` on your issue are
  silently rejected. Override per workflow:
  - `operators: [username, ...]` — allowlist specific extra users.
  - `open: true` — accept from anyone (only use for harmless verbs).
- **Session-level verbs** (`/ai stop`, `/ai status`, ...) — always
  require trusted association. No per-workflow override.

Trusted association + shared secret is the whole auth model. For
multi-org SaaS you'd want a GitHub App per tenant (interface in
`src/github/app.ts` is shaped for it, not wired yet).

See `CLAUDE.md` for per-file notes.

MIT.
