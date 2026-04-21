/**
 * Auto-detect where Claude Code credentials live on the host, then
 * return a host path that Docker can bind-mount into session
 * containers at /credentials/claude.
 *
 * This is the "configurable but zero-setup on standard machines"
 * piece the user asked for. Works on:
 *   - Linux  (bare metal + Docker native socket)
 *   - Windows Docker Desktop (translates C:\Users\... to //c/Users/...)
 *   - macOS Docker Desktop  (~/.claude passes through directly)
 *   - Running inside a Docker container that bind-mounts the host
 *     /home or /root — caller supplies HOST_HOME env.
 *
 * Override via CLAUDE_CREDENTIALS_HOST_PATH.
 *
 * Resolution order:
 *   1. Explicit override.
 *   2. HOST_HOME/.claude (when router runs in a container with host
 *      home mounted — check credentials/.credentials.json existence).
 *   3. $HOME/.claude (bare metal).
 *   4. Platform default — %USERPROFILE%\.claude on Windows.
 *   5. Known multi-user locations: /home/*\/.claude, /root/.claude.
 *
 * Returned path is the DOCKER-formatted host path (forward slashes
 * on Windows Docker Desktop).
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { log } from '../log.js';

export interface AuthDetection {
  /** Host path (in Docker-mountable form). */
  hostPath: string | null;
  /** One of: 'override' | 'host-mount' | 'home' | 'windows' | 'scan' | 'none' */
  source: string;
  /** True if the detected path contains a valid credentials file. */
  hasCredentials: boolean;
  /** Platform string for diagnostics. */
  platform: NodeJS.Platform;
  /** Whether we translated a Windows path into Docker Desktop form. */
  windowsTranslated: boolean;
}

function credentialsExist(claudeDir: string): boolean {
  try {
    return (
      fs.existsSync(path.join(claudeDir, '.credentials.json')) ||
      fs.existsSync(path.join(claudeDir, 'credentials.json'))
    );
  } catch {
    return false;
  }
}

/**
 * Convert `C:\Users\<you>\.claude` → `//c/Users/<you>/.claude`
 * (Docker Desktop's canonical host path form). Also accepts
 * already-translated paths and leaves them alone.
 */
function toDockerHostPath(p: string): { path: string; translated: boolean } {
  if (process.platform !== 'win32') return { path: p, translated: false };
  // Already Docker-form.
  if (/^\/\/[a-z]\//i.test(p)) return { path: p, translated: false };
  // Drive-letter Windows path.
  const m = /^([a-z]):[\\/]+(.*)$/i.exec(p);
  if (m) {
    const drive = m[1]!.toLowerCase();
    const rest = m[2]!.replace(/\\/g, '/');
    return { path: `//${drive}/${rest}`, translated: true };
  }
  return { path: p.replace(/\\/g, '/'), translated: true };
}

export function detectClaudeAuth(opts?: {
  override?: string;
  hostHome?: string;
}): AuthDetection {
  const platform = process.platform;
  const override = opts?.override ?? process.env.CLAUDE_CREDENTIALS_HOST_PATH;
  const hostHome = opts?.hostHome ?? process.env.HOST_HOME;

  // 1. Explicit override.
  if (override) {
    const t = toDockerHostPath(override);
    return {
      hostPath: t.path,
      source: 'override',
      hasCredentials: credentialsExist(override),
      platform,
      windowsTranslated: t.translated,
    };
  }

  // 2. Router running inside a container with host home mounted.
  if (hostHome) {
    const cand = path.join(hostHome, '.claude');
    if (credentialsExist(cand)) {
      const t = toDockerHostPath(cand);
      return {
        hostPath: t.path,
        source: 'host-mount',
        hasCredentials: true,
        platform,
        windowsTranslated: t.translated,
      };
    }
  }

  // 3. Current user's home directory.
  const home = os.homedir();
  if (home) {
    const cand = path.join(home, '.claude');
    if (credentialsExist(cand)) {
      const t = toDockerHostPath(cand);
      return {
        hostPath: t.path,
        source: 'home',
        hasCredentials: true,
        platform,
        windowsTranslated: t.translated,
      };
    }
  }

  // 4. Windows: USERPROFILE.
  if (platform === 'win32') {
    const up = process.env.USERPROFILE;
    if (up) {
      const cand = path.join(up, '.claude');
      if (credentialsExist(cand)) {
        const t = toDockerHostPath(cand);
        return {
          hostPath: t.path,
          source: 'windows',
          hasCredentials: true,
          platform,
          windowsTranslated: t.translated,
        };
      }
    }
  }

  // 5. Scan common multi-user locations (Linux/macOS only).
  if (platform !== 'win32') {
    const roots = ['/home', '/Users'];
    for (const root of roots) {
      if (!fs.existsSync(root)) continue;
      try {
        for (const user of fs.readdirSync(root)) {
          const cand = path.join(root, user, '.claude');
          if (credentialsExist(cand)) {
            return {
              hostPath: cand,
              source: 'scan',
              hasCredentials: true,
              platform,
              windowsTranslated: false,
            };
          }
        }
      } catch {
        /* ignore permission errors */
      }
    }
    // Root install.
    if (credentialsExist('/root/.claude')) {
      return {
        hostPath: '/root/.claude',
        source: 'scan',
        hasCredentials: true,
        platform,
        windowsTranslated: false,
      };
    }
  }

  return {
    hostPath: null,
    source: 'none',
    hasCredentials: false,
    platform,
    windowsTranslated: false,
  };
}

/**
 * Compute the bind-mount string Docker expects, given a detection.
 * `null` means "don't mount credentials, fall back to ANTHROPIC_API_KEY".
 */
export function claudeCredentialsBind(
  detection: AuthDetection,
): { source: string; target: string; mode: 'ro' } | null {
  if (!detection.hostPath) return null;
  return { source: detection.hostPath, target: '/credentials/claude', mode: 'ro' };
}

// ── CLI entry point: `npm run detect-auth` ───────────────────────
// Run directly via tsx / node to print the detection result.
const isMain =
  import.meta.url === `file://${process.argv[1]?.replace(/\\/g, '/')}` ||
  import.meta.url.endsWith(process.argv[1]?.replace(/\\/g, '/') ?? '');

if (isMain) {
  const det = detectClaudeAuth();
  const bind = claudeCredentialsBind(det);
  log.info(
    {
      platform: det.platform,
      hostPath: det.hostPath,
      source: det.source,
      hasCredentials: det.hasCredentials,
      windowsTranslated: det.windowsTranslated,
      bind,
    },
    'claude auth detection',
  );
  if (!det.hasCredentials) {
    log.warn(
      'No Claude credentials detected. Either set ANTHROPIC_API_KEY in .env or set CLAUDE_CREDENTIALS_HOST_PATH to the host path of your ~/.claude directory.',
    );
  }
}
