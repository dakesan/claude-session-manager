#!/usr/bin/env node
/**
 * CLI entry point for Claude Session Manager.
 * Serves the Hono HTTP app and a WebSocket-based terminal (/ws/terminal).
 */

import { createAdaptorServer } from "@hono/node-server";
import { WebSocketServer, type WebSocket as WsWebSocket } from "ws";
import * as pty from "node-pty";

import { app } from "./server.js";

const host = process.env.HOST || "0.0.0.0";
const port = parseInt(process.env.PORT || "8321", 10);

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

  // Spawn a login shell via node-pty
  const shell = process.env.SHELL || "/bin/bash";
  const ptyProcess = pty.spawn(shell, ["-l"], {
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
});
