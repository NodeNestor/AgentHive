/**
 * Workflow loader. Fetches a tenant's `.agents/workflows/*.yml`
 * via Octokit (when auth configured) and parses each into a
 * validated `Workflow`. Result is cached in memory with a 5-min
 * TTL, keyed by tenant.
 *
 * Local dev fallback: if no GitHub auth, load from the `examples/
 * workflows/` directory in this repo. That way `docker compose
 * up` with no config still demonstrates the system.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import yaml from 'js-yaml';
import { WorkflowSchema, type Workflow } from './schema.js';
import { octokitFor, hasAuth } from '../github/app.js';
import { log } from '../log.js';

const TTL_MS = 5 * 60 * 1000;
const cache = new Map<string, { workflows: Workflow[]; at: number }>();

function examplesDir(): string {
  return process.env.EXAMPLES_WORKFLOWS_DIR
    ? path.resolve(process.env.EXAMPLES_WORKFLOWS_DIR)
    : fileURLToPath(new URL('../../examples/workflows', import.meta.url));
}

/** Load from disk — used for local dev (no auth) and examples. */
function loadFromDisk(dir: string): Workflow[] {
  if (!fs.existsSync(dir)) return [];
  const out: Workflow[] = [];
  for (const f of fs.readdirSync(dir)) {
    if (!/\.ya?ml$/.test(f)) continue;
    try {
      const raw = yaml.load(fs.readFileSync(path.join(dir, f), 'utf8')) as unknown;
      out.push(WorkflowSchema.parse(raw));
    } catch (err) {
      log.warn({ err, file: f }, 'failed to parse workflow');
    }
  }
  return out;
}

/** Fetch from the tenant repo via Octokit. */
async function loadFromRepo(tenant: string): Promise<Workflow[]> {
  const [owner, repo] = tenant.split('/');
  if (!owner || !repo) return [];

  try {
    const gh = await octokitFor(tenant);
    const r = await gh.rest.repos.getContent({
      owner,
      repo,
      path: '.agents/workflows',
    });
    if (!Array.isArray(r.data)) {
      log.warn({ tenant }, '.agents/workflows is not a directory');
      return [];
    }
    const out: Workflow[] = [];
    for (const entry of r.data) {
      if (entry.type !== 'file' || !/\.ya?ml$/.test(entry.name)) continue;
      const file = await gh.rest.repos.getContent({ owner, repo, path: entry.path });
      if (!('content' in file.data)) continue;
      const text = Buffer.from(file.data.content, 'base64').toString('utf8');
      try {
        out.push(WorkflowSchema.parse(yaml.load(text)));
      } catch (err) {
        log.warn({ err, tenant, file: entry.name }, 'workflow schema invalid');
      }
    }
    return out;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes('Not Found') || msg.includes('404')) return [];
    log.warn({ err, tenant }, 'failed to list tenant workflows');
    return [];
  }
}

export async function loadWorkflows(tenant: string): Promise<Workflow[]> {
  const hit = cache.get(tenant);
  const now = Date.now();
  if (hit && now - hit.at < TTL_MS) return hit.workflows;

  let workflows: Workflow[];
  if (hasAuth() && tenant.includes('/')) {
    workflows = await loadFromRepo(tenant);
    if (workflows.length === 0) workflows = loadFromDisk(examplesDir()); // fall back to examples
  } else {
    workflows = loadFromDisk(examplesDir());
  }
  cache.set(tenant, { workflows: workflows.filter((w) => w.enabled), at: now });
  return workflows;
}

export async function getWorkflow(
  tenant: string,
  name: string,
): Promise<Workflow | undefined> {
  const all = await loadWorkflows(tenant);
  return all.find((w) => w.name === name);
}

export function invalidateWorkflows(tenant: string): void {
  cache.delete(tenant);
}

/** For /health — returns the examples shipped in this repo. */
export function listLocalExampleWorkflows(): Workflow[] {
  return loadFromDisk(examplesDir());
}
