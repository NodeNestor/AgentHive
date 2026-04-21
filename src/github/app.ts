/**
 * GitHub auth — PAT only, single shared Octokit.
 *
 * The router uses ONE `GITHUB_TOKEN` to act on every repo it
 * serves. Fine for "me + my repos" and for "me + some clients'
 * repos I have write access to". If you need per-org install
 * tokens (serving other people's orgs without sharing your PAT),
 * add a GitHub App later — the interface here is shaped so we
 * could plug it in without touching callers.
 */
import { Octokit } from '@octokit/rest';
import { config } from '../config.js';
import { log } from '../log.js';

let cached: Octokit | null = null;

/** True if the router can talk to GitHub. */
export function hasAuth(): boolean {
  return !!config.GITHUB_TOKEN;
}

/**
 * Get an authenticated Octokit. The `tenant` argument is ignored
 * today (one PAT for everything); keeping the signature so a
 * future GitHub-App mode can be a drop-in.
 */
// eslint-disable-next-line @typescript-eslint/no-unused-vars
export async function octokitFor(_tenant: string): Promise<Octokit> {
  if (!config.GITHUB_TOKEN) {
    throw new Error('GITHUB_TOKEN not set');
  }
  if (!cached) cached = new Octokit({ auth: config.GITHUB_TOKEN });
  return cached;
}

log.info({ hasToken: !!config.GITHUB_TOKEN }, 'github auth');
