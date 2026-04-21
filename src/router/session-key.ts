/**
 * Session key. Routing + state identity for one agent conversation:
 *
 *   <tenant>/<workflow>/<scope>
 *
 *   tenant   — e.g. "nodenestor/byttr"
 *   workflow — the lowercase name of a workflow YAML in that repo
 *              (e.g. "fix-issues", "test-prs")
 *   scope    — continuity unit per the workflow's scope strategy:
 *              "issue-42", "pr-87", "commit-abc123def456",
 *              "branch-main", or "global".
 */
import type { Workflow } from '../workflows/schema.js';

export interface SessionKey {
  tenant: string;
  workflow: string;
  scope: string;
}

export function keyToString(k: SessionKey): string {
  return `${normalise(k.tenant)}/${normalise(k.workflow)}/${normalise(k.scope)}`;
}

export function stringToKey(s: string): SessionKey {
  const parts = s.split('/');
  if (parts.length < 3) throw new Error(`invalid session key: ${s}`);
  return {
    tenant: parts.slice(0, parts.length - 2).join('/'),
    workflow: parts[parts.length - 2]!,
    scope: parts[parts.length - 1]!,
  };
}

export function scopeFor(
  strategy: Workflow['scope'],
  ctx: {
    issueNumber?: number;
    prNumber?: number;
    commitSha?: string;
    branch?: string;
  },
): string {
  switch (strategy) {
    case 'issue':
      if (ctx.issueNumber == null) throw new Error('scope=issue requires issueNumber');
      return `issue-${ctx.issueNumber}`;
    case 'pr':
      if (ctx.prNumber == null) throw new Error('scope=pr requires prNumber');
      return `pr-${ctx.prNumber}`;
    case 'commit':
      if (!ctx.commitSha) throw new Error('scope=commit requires commitSha');
      return `commit-${ctx.commitSha.slice(0, 12)}`;
    case 'branch':
      if (!ctx.branch) throw new Error('scope=branch requires branch');
      return `branch-${slugify(ctx.branch)}`;
    case 'global':
      return 'global';
  }
}

function normalise(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9_/-]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
}

function slugify(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

export function keyToContainerName(k: SessionKey): string {
  const raw = `${k.tenant}-${k.workflow}-${k.scope}`.replace(/\//g, '-');
  return `agent-${raw.replace(/[^a-zA-Z0-9_.-]/g, '-').slice(0, 58)}`;
}
