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

export interface RemoteNode {
  /** Display name for this node */
  name: string;
  /** Base URL of the remote CSM instance (e.g. "http://192.168.1.10:8321") */
  url: string;
}

export interface CsmConfig {
  server: {
    host: string;
    port: number;
    /** Operating mode: standalone (default), host (aggregates remotes), client (serves local only) */
    mode: "standalone" | "host" | "client";
  };
  paths: {
    tmux: string;
    claude: string;
    claudeConfigDir: string;
  };
  session: {
    dangerouslySkipPermissions: boolean;
  };
  lifecycle: {
    /** Days after last jsonl activity to auto-archive a stopped session */
    archiveAfterDays: number;
    /** Days after last jsonl activity to auto-archive a schedule-derived session */
    archiveAfterDaysScheduled: number;
    /** How often the cleanup sweep runs */
    cleanupIntervalMinutes: number;
  };
  /** Remote CSM nodes to aggregate (only used when mode = "host") */
  remotes: RemoteNode[];
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
      mode: "standalone",
    },
    paths: {
      tmux: whichSync("tmux") || "tmux",
      claude: whichSync("claude") || "claude",
      claudeConfigDir: resolve(homedir(), ".claude"),
    },
    session: {
      dangerouslySkipPermissions: true,
    },
    lifecycle: {
      archiveAfterDays: 7,
      archiveAfterDaysScheduled: 3,
      cleanupIntervalMinutes: 60,
    },
    remotes: [],
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
        if (typeof server.mode === "string" && ["standalone", "host", "client"].includes(server.mode)) {
          config.server.mode = server.mode as CsmConfig["server"]["mode"];
        }
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

      const lifecycle = toml.lifecycle as Record<string, unknown> | undefined;
      if (lifecycle) {
        if (typeof lifecycle.archive_after_days === "number" && lifecycle.archive_after_days >= 0) {
          config.lifecycle.archiveAfterDays = lifecycle.archive_after_days;
        }
        if (
          typeof lifecycle.archive_after_days_scheduled === "number" &&
          lifecycle.archive_after_days_scheduled >= 0
        ) {
          config.lifecycle.archiveAfterDaysScheduled = lifecycle.archive_after_days_scheduled;
        }
        if (
          typeof lifecycle.cleanup_interval_minutes === "number" &&
          lifecycle.cleanup_interval_minutes >= 1
        ) {
          config.lifecycle.cleanupIntervalMinutes = lifecycle.cleanup_interval_minutes;
        }
      }

      // Parse [[remotes]] array
      const remotes = toml.remotes as Array<Record<string, unknown>> | undefined;
      if (Array.isArray(remotes)) {
        for (const r of remotes) {
          if (typeof r.name === "string" && typeof r.url === "string") {
            config.remotes.push({ name: r.name, url: r.url.replace(/\/+$/, "") });
          }
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
  if (process.env.CSM_MODE && ["standalone", "host", "client"].includes(process.env.CSM_MODE)) {
    config.server.mode = process.env.CSM_MODE as CsmConfig["server"]["mode"];
  }

  return config;
}

// Singleton — loaded once at import time
export const CONFIG = loadConfig();
