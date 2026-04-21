/**
 * Parse operator slash commands from issue/PR comments.
 *
 *   /ai <workflow> <message>    Fire a named workflow (any workflow
 *                               with `slash: <name>` declared), with
 *                               the rest of the comment as context.
 *
 *   /ai stop                    Ask the current session to stop.
 *   /ai status                  Ask the session to post status.
 *   /ai logs                    Ask the session to dump its tail.
 *   /ai retry                   Re-enqueue the last failed task.
 *
 * The router doesn't hardcode workflow names — consumers add a
 * `slash: <verb>` field to any workflow and then `/ai <verb>`
 * fires it.
 */

export type SlashCommand =
  | { kind: 'workflow'; workflow: string; message: string }
  | { kind: 'stop' }
  | { kind: 'status' }
  | { kind: 'logs' }
  | { kind: 'retry' };

export function parseSlashCommand(body: string): SlashCommand | null {
  const trimmed = body.trim();
  if (!trimmed.startsWith('/ai')) return null;

  const after = trimmed.slice(3).trim();
  if (!after) return null;

  const [verb, ...rest] = after.split(/\s+/);
  const msg = rest.join(' ').trim();
  const v = (verb ?? '').toLowerCase();

  switch (v) {
    case 'stop':
      return { kind: 'stop' };
    case 'status':
      return { kind: 'status' };
    case 'logs':
      return { kind: 'logs' };
    case 'retry':
      return { kind: 'retry' };
    default:
      // Anything else is interpreted as a workflow name.
      return { kind: 'workflow', workflow: v, message: msg };
  }
}
