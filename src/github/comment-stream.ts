/**
 * Progressive comment streamer. Maps a (tenant, stream_to) pair to a
 * single GitHub comment that we edit as the agent works — instead of
 * flooding the PR/issue with new comments each turn.
 *
 * stream_to syntax:
 *   issue:<N>         → create/edit a comment on issue #N
 *   pr:<N>            → create/edit a comment on PR #N (same as
 *                       issue comment; GitHub treats PRs as issues)
 *   commit:<SHA>      → create/edit a commit comment
 *   webhook:<URL>     → POST updates to an external URL (Slack etc.)
 *
 * We cap body length (GitHub's limit is ~65k chars) and keep only
 * the last ~40k to stay well under it. Updates are throttled — at
 * most 1 edit every 3 seconds per stream to avoid rate-limiting.
 */
import { getStreamComment, setStreamComment } from '../db.js';
import { octokitFor, hasAuth } from './app.js';
import { log } from '../log.js';

const MAX_BODY = 40_000;
const MIN_EDIT_INTERVAL_MS = 3_000;

const lastEditAt = new Map<string, number>();
const pending = new Map<string, { body: string; scheduledAt: number }>();

function keyFor(tenant: string, streamTo: string): string {
  return `${tenant}::${streamTo}`;
}

function parseStreamTo(s: string): {
  kind: 'issue' | 'pr' | 'commit' | 'webhook';
  ref: string;
} {
  const [kind, ref = ''] = s.split(':', 2);
  if (!['issue', 'pr', 'commit', 'webhook'].includes(kind!)) {
    throw new Error(`unknown stream_to kind: ${s}`);
  }
  return { kind: kind as 'issue' | 'pr' | 'commit' | 'webhook', ref };
}

function formatBody(raw: string): string {
  const tail = raw.slice(-MAX_BODY);
  return (
    '<!-- agenthive:comment-stream -->\n' +
    '```\n' +
    tail.replace(/```/g, '``​`') +
    '\n```\n' +
    `<sub>Updated at ${new Date().toISOString()} · edits in place during the run</sub>`
  );
}

async function apply(
  tenant: string,
  streamTo: string,
  rawBody: string,
): Promise<void> {
  const parsed = parseStreamTo(streamTo);
  const body = formatBody(rawBody);

  if (parsed.kind === 'webhook') {
    try {
      await fetch(parsed.ref, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ tenant, streamTo, body: rawBody }),
      });
    } catch (err) {
      log.warn({ err, streamTo }, 'external webhook post failed');
    }
    return;
  }

  if (!hasAuth()) {
    log.debug({ tenant, streamTo }, 'skip comment edit — no github auth');
    return;
  }

  const [owner, repo] = tenant.split('/');
  if (!owner || !repo) {
    log.warn({ tenant }, 'stream target tenant must be owner/repo');
    return;
  }

  const gh = await octokitFor(tenant);
  const existing = getStreamComment(tenant, streamTo);

  try {
    if (parsed.kind === 'commit') {
      if (existing?.comment_id) {
        await gh.rest.repos.updateCommitComment({
          owner,
          repo,
          comment_id: existing.comment_id,
          body,
        });
      } else {
        const r = await gh.rest.repos.createCommitComment({
          owner,
          repo,
          commit_sha: parsed.ref,
          body,
        });
        setStreamComment(tenant, streamTo, r.data.id, rawBody);
        return;
      }
    } else {
      // issue + pr
      const issueNum = Number(parsed.ref);
      if (existing?.comment_id) {
        await gh.rest.issues.updateComment({
          owner,
          repo,
          comment_id: existing.comment_id,
          body,
        });
      } else {
        const r = await gh.rest.issues.createComment({
          owner,
          repo,
          issue_number: issueNum,
          body,
        });
        setStreamComment(tenant, streamTo, r.data.id, rawBody);
        return;
      }
    }
    setStreamComment(tenant, streamTo, existing?.comment_id ?? null, rawBody);
  } catch (err) {
    log.warn({ err, tenant, streamTo }, 'comment edit failed');
  }
}

/** Public entry — throttled so we don't spam GitHub's rate limit. */
export async function updateStreamComment(
  tenant: string,
  streamTo: string,
  rawBody: string,
): Promise<void> {
  const k = keyFor(tenant, streamTo);
  const now = Date.now();
  const last = lastEditAt.get(k) ?? 0;

  if (now - last >= MIN_EDIT_INTERVAL_MS) {
    lastEditAt.set(k, now);
    await apply(tenant, streamTo, rawBody);
    pending.delete(k);
    return;
  }

  // Too soon — coalesce. Keep the latest body; schedule a flush once.
  const existing = pending.get(k);
  const scheduledAt = existing?.scheduledAt ?? last + MIN_EDIT_INTERVAL_MS;
  pending.set(k, { body: rawBody, scheduledAt });
  if (!existing) {
    const delay = Math.max(0, scheduledAt - now);
    setTimeout(async () => {
      const p = pending.get(k);
      if (!p) return;
      lastEditAt.set(k, Date.now());
      pending.delete(k);
      await apply(tenant, streamTo, p.body);
    }, delay);
  }
}
