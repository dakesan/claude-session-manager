#!/usr/bin/env node
/**
 * CLI entry point for Claude Session Manager.
 *
 * Subcommands:
 *   (none) / serve   — Start the HTTP + WebSocket server (default)
 *   install-service  — Generate and enable a systemd user service
 *   uninstall-service — Stop and remove the systemd user service
 */

import { createAdaptorServer } from "@hono/node-server";
import { WebSocketServer, type WebSocket as WsWebSocket } from "ws";
import * as pty from "node-pty";
import { existsSync, mkdirSync, writeFileSync, unlinkSync } from "node:fs";
import { execSync } from "node:child_process";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { app } from "./server.js";
import { CONFIG } from "./config.js";
import { initScheduler } from "./scheduler.js";
import * as cli from "./claude-cli.js";

// ---------------------------------------------------------------------------
// Subcommand routing
// ---------------------------------------------------------------------------

const subcommand = process.argv[2] || "serve";

if (subcommand === "install-service") {
  installService();
  process.exit(0);
} else if (subcommand === "uninstall-service") {
  uninstallService();
  process.exit(0);
} else if (subcommand !== "serve") {
  console.error(
    `Unknown command: ${subcommand}\n\n` +
    `Usage:\n` +
    `  node dist/cli.js                  Start the server (default)\n` +
    `  node dist/cli.js serve            Start the server\n` +
    `  node dist/cli.js install-service  Install as systemd user service\n` +
    `  node dist/cli.js uninstall-service Remove the systemd user service\n`
  );
  process.exit(1);
}

// ---------------------------------------------------------------------------
// install-service
// ---------------------------------------------------------------------------

function installService(): void {
  const home = process.env.HOME;
  if (!home) {
    console.error("Error: $HOME is not set.");
    process.exit(1);
  }

  // Detect project root (parent of dist/)
  const thisFile = fileURLToPath(import.meta.url);
  const projectRoot = resolve(dirname(thisFile), "..");

  // Detect the Node.js binary that is running this script
  const nodeBin = process.execPath;

  // Use config values for the service
  const host = CONFIG.server.host;
  const port = String(CONFIG.server.port);

  const serviceName = "csm";
  const serviceDir = resolve(home, ".config/systemd/user");
  const servicePath = resolve(serviceDir, `${serviceName}.service`);

  const unit = [
    "[Unit]",
    "Description=Claude Session Manager (CSM)",
    "After=network.target",
    "",
    "[Service]",
    "Type=simple",
    `WorkingDirectory=${projectRoot}`,
    `ExecStart=${nodeBin} dist/cli.js`,
    "Restart=on-failure",
    "RestartSec=5",
    "Environment=NODE_ENV=production",
    `Environment=HOST=${host}`,
    `Environment=PORT=${port}`,
    "",
    "[Install]",
    "WantedBy=default.target",
  ].join("\n") + "\n";

  // Write the service file
  if (!existsSync(serviceDir)) {
    mkdirSync(serviceDir, { recursive: true });
  }
  writeFileSync(servicePath, unit, "utf-8");
  console.log(`✓ Service file written to ${servicePath}`);

  // Reload systemd and enable + start the service
  try {
    execSync("systemctl --user daemon-reload", { stdio: "inherit" });
    execSync(`systemctl --user enable ${serviceName}.service`, { stdio: "inherit" });
    execSync(`systemctl --user start ${serviceName}.service`, { stdio: "inherit" });
    console.log(`\n✓ Service "${serviceName}" enabled and started.`);
    console.log(`  Status:  systemctl --user status ${serviceName}`);
    console.log(`  Logs:    journalctl --user -u ${serviceName} -f`);
    console.log(`  Stop:    systemctl --user stop ${serviceName}`);
    console.log(`  Remove:  node dist/cli.js uninstall-service`);
  } catch {
    console.error(
      "\nFailed to enable/start the service via systemctl.\n" +
      `The service file has been written to ${servicePath}.\n` +
      "You can manually run:\n" +
      `  systemctl --user daemon-reload\n` +
      `  systemctl --user enable --now ${serviceName}.service`
    );
    process.exit(1);
  }
}

// ---------------------------------------------------------------------------
// uninstall-service
// ---------------------------------------------------------------------------

function uninstallService(): void {
  const home = process.env.HOME;
  if (!home) {
    console.error("Error: $HOME is not set.");
    process.exit(1);
  }

  const serviceName = "csm";
  const servicePath = resolve(home, ".config/systemd/user", `${serviceName}.service`);

  try {
    execSync(`systemctl --user stop ${serviceName}.service 2>/dev/null`, { stdio: "inherit" });
  } catch {
    // May already be stopped — ignore
  }
  try {
    execSync(`systemctl --user disable ${serviceName}.service 2>/dev/null`, { stdio: "inherit" });
  } catch {
    // May not be enabled — ignore
  }

  if (existsSync(servicePath)) {
    unlinkSync(servicePath);
    console.log(`✓ Removed ${servicePath}`);
  } else {
    console.log(`Service file not found at ${servicePath} — nothing to remove.`);
  }

  try {
    execSync("systemctl --user daemon-reload", { stdio: "inherit" });
  } catch {
    // best-effort
  }

  console.log(`✓ Service "${serviceName}" uninstalled.`);
}

// ---------------------------------------------------------------------------
// Default: serve
// ---------------------------------------------------------------------------

const host = CONFIG.server.host;
const port = CONFIG.server.port;

// Create the Node.js HTTP server from Hono
const server = createAdaptorServer(app);

// WebSocket server on the same HTTP server, handling /ws/terminal path
const wss = new WebSocketServer({ noServer: true });

server.on("upgrade", (req, socket, head) => {
  const pathname = new URL(req.url || "/", `http://${req.headers.host}`).pathname;
  if (pathname === "/ws/terminal") {
    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit("connection", ws, req);
    });
  } else {
    socket.destroy();
  }
});

wss.on("connection", (ws: WsWebSocket, req) => {
  const url = new URL(req.url || "/", `http://${req.headers.host}`);
  const cwd = url.searchParams.get("cwd") || process.env.HOME || "/";
  const cols = parseInt(url.searchParams.get("cols") || "120", 10);
  const rows = parseInt(url.searchParams.get("rows") || "30", 10);

  // Spawn a login shell via node-pty. pty.spawn throws synchronously when the
  // OS cannot fork (e.g. "posix_spawnp failed" under fd/process pressure).
  // That exception is raised inside this ws event handler, so if it escapes it
  // becomes an uncaughtException and takes the whole server down — killing all
  // in-flight requests, including remote session proxying. Contain it: report
  // to the client and close this socket instead of crashing the process.
  const shell = process.env.SHELL || "/bin/bash";
  let ptyProcess: pty.IPty;
  try {
    ptyProcess = pty.spawn(shell, ["-l"], {
      name: "xterm-256color",
      cols,
      rows,
      cwd,
      env: {
        ...process.env,
        TERM: "xterm-256color",
        COLORTERM: "truecolor",
      } as Record<string, string>,
    });
  } catch (e) {
    const detail = e instanceof Error ? e.message : String(e);
    console.error(`[csm] pty.spawn failed for cwd=${cwd}: ${detail}`);
    if (ws.readyState === ws.OPEN) {
      ws.send(`\r\n[Failed to open terminal: ${detail}]\r\n`);
      ws.close();
    }
    return;
  }

  // PTY → Browser
  ptyProcess.onData((data: string) => {
    if (ws.readyState === ws.OPEN) {
      ws.send(data);
    }
  });

  ptyProcess.onExit(({ exitCode }) => {
    if (ws.readyState === ws.OPEN) {
      ws.send(`\r\n[Process exited with code ${exitCode}]\r\n`);
      ws.close();
    }
  });

  // Browser → PTY (raw input or resize control message)
  ws.on("message", (msg: Buffer | string) => {
    const data = msg.toString();

    // Handle resize messages: {"type":"resize","cols":N,"rows":N}
    if (data.charAt(0) === "{") {
      try {
        const parsed = JSON.parse(data);
        if (parsed.type === "resize" && parsed.cols && parsed.rows) {
          ptyProcess.resize(parsed.cols, parsed.rows);
          return;
        }
      } catch {
        // not JSON — fall through to write as terminal input
      }
    }

    ptyProcess.write(data);
  });

  ws.on("close", () => {
    ptyProcess.kill();
  });

  ws.on("error", () => {
    ptyProcess.kill();
  });
});

server.listen(port, host, () => {
  console.log(`✻ Claude Session Manager listening on http://${host}:${port}`);
  console.log(`  WebSocket terminal at ws://${host}:${port}/ws/terminal`);
  // Load persisted schedules and start cron timers
  void initScheduler().catch((e) => {
    console.error("Failed to initialize scheduler:", e);
  });

  // Periodic archive sweep: stopped sessions older than the configured TTL
  // get the archivedAt flag set so the dashboard hides them from the default list.
  const sweepMs = CONFIG.lifecycle.cleanupIntervalMinutes * 60 * 1000;
  const runSweep = async () => {
    try {
      const result = await cli.runArchiveSweep();
      if (result.archived > 0) {
        console.log(`[lifecycle] auto-archived ${result.archived} session(s)`);
      }
    } catch (e) {
      console.error("[lifecycle] sweep failed:", e);
    }
  };
  // Run once on startup, then on the configured interval
  void runSweep();
  setInterval(runSweep, sweepMs);
  console.log(
    `  Archive sweep every ${CONFIG.lifecycle.cleanupIntervalMinutes}min ` +
      `(TTL: ${CONFIG.lifecycle.archiveAfterDays}d normal / ` +
      `${CONFIG.lifecycle.archiveAfterDaysScheduled}d scheduled)`,
  );
});
