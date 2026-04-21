# AgentHive — internal notes

Thin router. Zero built-in agents. All agent logic lives in YAML.

## Files

- `src/server.ts` — Hono HTTP routes.
- `src/router/dispatcher.ts` — event → workflow → session.
- `src/router/session-key.ts` — `<tenant>/<workflow>/<scope>`.
- `src/workflows/schema.ts` — zod schema for workflow YAML.
- `src/workflows/loader.ts` — Octokit fetch + 5-min cache. Falls
  back to `examples/workflows/` when no auth is set.
- `src/workflows/render.ts` — template engine + hook-script gen.
- `src/docker/session-container.ts` — AgentCore lifecycle.
- `src/docker/auth-detect.ts` — Claude credential auto-detect.
- `src/docker/control-api.ts` — non-spawning helpers used by
  watchdog.
- `src/streams/agent-tailer.ts` — tmux tail + signal tags.
- `src/workers/inbox-worker.ts` — inbox pump (send-keys).
- `src/workers/watchdog.ts` — wall-clock hang detection.
- `src/github/app.ts` — PAT Octokit.
- `src/github/comment-stream.ts` — throttled comment editing.
- `src/github/slash-commands.ts` — `/ai ...` parser.
- `hooks-lib/lib.sh` — shared bash mounted into agent containers.

## Contracts

- **Session key** `<tenant>/<workflow>/<scope>` — same key = same
  warm container.
- **Stop hook exit codes**: 0 = stop allowed, 2 = block stop and
  inject stdout as next user message.
- **Template grammar**: `{{dotted.path}}` only. Put logic in
  `stop_when` bash.

## Don't

- Don't hardcode anything role-specific. YAML is authority.
- Don't cache tokens yourself (we only have a PAT now, but keep
  `octokitFor(tenant)` signature so GitHub App can be plugged in).
- Don't use `docker stop $(docker ps -q)` anywhere — filter by
  the `agenthive.*` labels.
