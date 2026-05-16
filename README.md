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
uv tool install git+https://github.com/dakesan/claude-session-manager.git
```

Or for development:

```bash
git clone https://github.com/dakesan/claude-session-manager.git
cd claude-session-manager
uv sync
```

## Usage

```bash
# Start the server
claude-session-manager serve

# Custom host/port
claude-session-manager serve --host 127.0.0.1 --port 9000

# Development mode with auto-reload
claude-session-manager serve --reload
```

Then open `http://<your-server>:8321` in your browser.

## Architecture

```
Browser (Tailscale) → FastAPI (port 8321) → Claude CLI
                          │
                          ├── GET  /api/sessions          → ls ~/.claude/jobs/
                          ├── POST /api/sessions          → claude --bg "prompt"
                          ├── POST /api/sessions/:id/stop → claude stop <id>
                          ├── POST /api/sessions/:id/respawn → claude respawn <id>
                          ├── DELETE /api/sessions/:id    → claude rm <id>
                          └── GET  /api/sessions/:id/logs → claude logs <id>
```

The backend reads session state directly from `~/.claude/jobs/` and `~/.claude/daemon/roster.json`, then delegates actions to the `claude` CLI.

## systemd (Optional)

User-level service:

```bash
cp contrib/claude-session-manager-user.service ~/.config/systemd/user/claude-session-manager.service
systemctl --user daemon-reload
systemctl --user enable --now claude-session-manager
```

## Requirements

- Python 3.11+
- Claude Code CLI (`claude`) installed and authenticated
- Recommended: Tailscale for secure remote access

## License

MIT
