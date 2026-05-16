# Claude Session Manager

Web-based dashboard for managing Claude Code background sessions and Remote Control.

Launch, monitor, stop, respawn, and remove `claude --bg` sessions from a browser — designed for access over Tailscale or other private networks.

## Features

- Session list with live state updates (auto-refresh every 3s)
- Launch new background sessions from the UI
- View session logs
- Stop / Respawn / Remove sessions
- Remote Control link integration (click to open claude.ai/code)
- Terminal-inspired dark UI, mobile-friendly

## Install

```bash
npm install -g claude-session-manager
```

Or from source:

```bash
git clone https://github.com/dakesan/claude-session-manager.git
cd claude-session-manager
npm install
npm run build
```

## Usage

```bash
# Start the server (default: 0.0.0.0:8321)
claude-session-manager

# Custom host/port via env vars
PORT=9000 HOST=127.0.0.1 claude-session-manager

# Development mode
npm run dev
```

Then open `http://<your-server>:8321` in your browser.

## Architecture

```
Browser (Tailscale) → Hono server (port 8321) → Claude CLI
                          │
                          ├── GET  /api/sessions          → ls ~/.claude/jobs/
                          ├── POST /api/sessions          → claude --bg "prompt"
                          ├── POST /api/sessions/:id/stop → claude stop <id>
                          ├── POST /api/sessions/:id/respawn → claude respawn <id>
                          ├── DELETE /api/sessions/:id    → claude rm <id>
                          └── GET  /api/sessions/:id/logs → claude logs <id>
```

The backend reads session state directly from `~/.claude/jobs/` and delegates actions to the `claude` CLI.

## Requirements

- Node.js 18+
- Claude Code CLI (`claude`) installed and authenticated
- Recommended: Tailscale for secure remote access

## License

MIT
