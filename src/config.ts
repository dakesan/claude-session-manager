/**
 * Configuration loader for Claude Session Manager.
 *
 * Priority (highest wins):
 *   1. Environment variables (HOST, PORT, etc.)
 *   2. csm.config.toml in project root
 *   3. Built-in defaults
 */

import { readFileSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";
import { parse as parseTOML } from "smol-toml";
import { execSync } from "node:child_process";

// ─── Types ──────────────────────────────────────────────────────────────────

export interface CsmConfig {
  server: {
    host: string;
    port: number;
  };
  paths: {
    tmux: string;
    claude: string;
    claudeConfigDir: string;
  };
  session: {
    dangerouslySkipPermissions: boolean;
  };
}

// ─── Helpers ────────────────────────────────────────────────────────────────

/** Resolve ~ to $HOME */
function expandHome(p: string): string {
  if (p.startsWith("~/") || p === "~") {
    return resolve(homedir(), p.slice(2));
  }
  return p;
}

/** Try to find a binary on $PATH */
function whichSync(bin: string): string | null {
  try {
    return execSync(`which ${bin} 2>/dev/null`, { encoding: "utf-8" }).trim() || null;
  } catch {
    return null;
  }
}

// ─── Loader ─────────────────────────────────────────────────────────────────

/** Locate csm.config.toml relative to the project root (parent of dist/) */
function findConfigFile(): string | null {
  const thisFile = fileURLToPath(import.meta.url);
  const projectRoot = resolve(dirname(thisFile), "..");
  const configPath = resolve(projectRoot, "csm.config.toml");
  return existsSync(configPath) ? configPath : null;
}

/** Load and merge configuration from TOML file, env vars, and defaults. */
export function loadConfig(): CsmConfig {
  // Defaults
  const config: CsmConfig = {
    server: {
      host: "0.0.0.0",
      port: 8321,
    },
    paths: {
      tmux: whichSync("tmux") || "tmux",
      claude: whichSync("claude") || "claude",
      claudeConfigDir: resolve(homedir(), ".claude"),
    },
    session: {
      dangerouslySkipPermissions: true,
    },
  };

  // Layer: TOML file
  const configFile = findConfigFile();
  if (configFile) {
    try {
      const raw = readFileSync(configFile, "utf-8");
      const toml = parseTOML(raw) as Record<string, unknown>;

      const server = toml.server as Record<string, unknown> | undefined;
      if (server) {
        if (typeof server.host === "string") config.server.host = server.host;
        if (typeof server.port === "number") config.server.port = server.port;
      }

      const paths = toml.paths as Record<string, unknown> | undefined;
      if (paths) {
        if (typeof paths.tmux === "string") config.paths.tmux = expandHome(paths.tmux);
        if (typeof paths.claude === "string") config.paths.claude = expandHome(paths.claude);
        if (typeof paths.claude_config_dir === "string") config.paths.claudeConfigDir = expandHome(paths.claude_config_dir);
      }

      const session = toml.session as Record<string, unknown> | undefined;
      if (session) {
        if (typeof session.dangerously_skip_permissions === "boolean") {
          config.session.dangerouslySkipPermissions = session.dangerously_skip_permissions;
        }
      }

      console.log(`  Config loaded from ${configFile}`);
    } catch (e) {
      console.error(`Warning: Failed to parse ${configFile}: ${e instanceof Error ? e.message : e}`);
    }
  }

  // Layer: Environment variables (highest priority)
  if (process.env.HOST) config.server.host = process.env.HOST;
  if (process.env.PORT) config.server.port = parseInt(process.env.PORT, 10);
  if (process.env.CLAUDE_CONFIG_DIR) config.paths.claudeConfigDir = process.env.CLAUDE_CONFIG_DIR;

  return config;
}

// Singleton — loaded once at import time
export const CONFIG = loadConfig();
