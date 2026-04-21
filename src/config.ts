/**
 * Runtime config. Small on purpose — every knob here is a promise
 * to maintain it.
 */
import 'dotenv/config';
import { z } from 'zod';
import path from 'node:path';

const schema = z.object({
  PORT: z.coerce.number().int().positive().default(7700),
  HOST: z.string().default('0.0.0.0'),
  PUBLIC_URL: z.string().url().default('http://localhost:7700'),
  DB_PATH: z.string().default('./data/agenthive.sqlite'),
  LOG_LEVEL: z.enum(['trace', 'debug', 'info', 'warn', 'error']).default('info'),

  // Shared secrets.
  WEBHOOK_SECRET: z.string().min(8, 'WEBHOOK_SECRET must be at least 8 chars'),
  DISPATCH_TOKEN: z.string().min(8, 'DISPATCH_TOKEN must be at least 8 chars'),

  // GitHub auth — PAT. Fine-grained or classic.
  GITHUB_TOKEN: z.string().optional(),

  // Claude auth. Either API key, or host creds path, or rely on
  // ~/.claude auto-detection.
  ANTHROPIC_API_KEY: z.string().optional(),
  CLAUDE_CREDENTIALS_HOST_PATH: z.string().optional(),

  // Containers.
  AGENTCORE_IMAGE: z.string().default('agentcore'),
  DOCKER_NETWORK: z.string().default('agenthive-net'),
  SESSION_STATE_ROOT: z.string().default('./state/sessions'),
  SESSION_MEMORY_MB: z.coerce.number().int().positive().default(2048),
  SESSION_CPU_CORES: z.coerce.number().positive().default(1.5),

  // Safety.
  DEFAULT_MAX_ATTEMPTS_PER_ISSUE: z.coerce.number().int().positive().default(3),
  DEFAULT_IDLE_TIMEOUT_SECONDS: z.coerce.number().int().positive().default(7 * 24 * 3600),
  RETRIGGERS_PER_HOUR_LIMIT: z.coerce.number().int().positive().default(20),

  // Watchdog.
  WATCHDOG_INTERVAL_SECONDS: z.coerce.number().int().positive().default(60),
  WATCHDOG_STUCK_SECONDS: z.coerce.number().int().positive().default(600),
  WATCHDOG_MAX_POKES: z.coerce.number().int().positive().default(3),
});

const parsed = schema.safeParse(process.env);
if (!parsed.success) {
  console.error('[config] invalid env:');
  for (const i of parsed.error.issues) console.error(`  ${i.path.join('.')}: ${i.message}`);
  process.exit(1);
}

const env = parsed.data;

export const config = Object.freeze({
  ...env,
  DB_PATH: path.resolve(env.DB_PATH),
  SESSION_STATE_ROOT: path.resolve(env.SESSION_STATE_ROOT),
});

export type Config = typeof config;
