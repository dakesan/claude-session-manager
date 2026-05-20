# Claude Session Manager (CSM)

Web dashboard + REST API + MCP server for managing Claude Code interactive sessions with Remote Control.

Sessions run as **interactive** Claude processes (not `-p` programmatic mode), using regular Claude Max credits. Each session launches inside a tmux pane with `--remote-control` enabled, making it accessible from claude.ai/code or the Claude mobile app.

## Requirements

- **Node.js 18+** (22+ recommended)
- **C/C++ compiler** — required for building `node-pty` (native addon)
  - Ubuntu/Debian: `sudo apt install build-essential`
  - macOS: Xcode Command Line Tools (`xcode-select --install`)
- **tmux** — sessions run inside tmux panes
- **Claude Code CLI v2.1.51+** — with `--remote-control` flag support
- **Claude Max subscription** — for Remote Control
- Recommended: **Tailscale** for secure remote access

## Installation

```bash
git clone https://github.com/dakesan/claude-session-manager.git
cd claude-session-manager
npm install        # builds node-pty native addon
npm run build      # compiles TypeScript → dist/
```

## Usage

### Start the server

```bash
node dist/cli.js
# or
npm start
```

Server starts at `http://0.0.0.0:8321`. Access the web dashboard or use the API directly.

Override host/port with environment variables:

```bash
HOST=127.0.0.1 PORT=9000 node dist/cli.js
```

### Run as a systemd service (Linux)

Register CSM as a systemd **user** service that starts on login and restarts on failure:

```bash
node dist/cli.js install-service
```

This auto-detects the project directory and Node.js binary path, writes the service file to `~/.config/systemd/user/csm.service`, and enables + starts it immediately.

Manage the service:

```bash
systemctl --user status csm       # check status
systemctl --user stop csm         # stop
systemctl --user restart csm      # restart
journalctl --user -u csm -f       # follow logs
```

To keep the service running after SSH logout:

```bash
loginctl enable-linger $USER
```

Uninstall:

```bash
node dist/cli.js uninstall-service
```

## API Reference

Base URL: `http://<host>:8321`

### Health Check

```bash
curl http://localhost:8321/api/health
```

Response: `{"status":"ok","version":"0.5.0","uptime":123.45}`

### List Sessions

```bash
curl http://localhost:8321/api/sessions
```

Returns an array of session objects. Working sessions appear first, sorted by creation time.

### Get Session

```bash
curl http://localhost:8321/api/sessions/<id>
```

`<id>` can be the full UUID or the 8-char short ID.

### Create Session

```bash
curl -X POST http://localhost:8321/api/sessions \
  -H 'Content-Type: application/json' \
  -d '{
    "prompt": "Fix the flaky test in checkout-flow.spec.ts",
    "name": "fix-flaky-test",
    "cwd": "/path/to/project"
  }'
```

| Field | Required | Description |
|-------|----------|-------------|
| `prompt` | Yes | Initial prompt to send to Claude |
| `name` | No | Session name (used as Remote Control name). Auto-generated if omitted |
| `cwd` | No | Working directory. Defaults to server's cwd |

Response includes `rcUrl` — a direct link to the Remote Control session on claude.ai/code.

Note: Takes ~13s to return (waits for RC URL capture). The session is usable immediately.

### Stop Session

```bash
curl -X POST http://localhost:8321/api/sessions/<id>/stop
```

Kills the tmux session (and claude process inside it).

### Remove Session

```bash
curl -X DELETE http://localhost:8321/api/sessions/<id>
```

Stops the session (if running) and removes CSM tracking metadata.

### Respawn Session

```bash
curl -X POST http://localhost:8321/api/sessions/<id>/respawn
```

Re-creates a stopped session with the same prompt and working directory.

### Get Logs (Transcript)

```bash
curl http://localhost:8321/api/sessions/<id>/logs
```

Returns the JSONL transcript formatted as readable log lines.

### Refresh Remote Control URL

```bash
curl http://localhost:8321/api/sessions/<id>/rc-url
```

Re-scans the tmux pane for the RC URL. Useful if `rcUrl` was not captured at creation time.

## Typical Workflow

```bash
# 1. Create a session from your phone/laptop via Tailscale
SESSION=$(curl -s -X POST http://lab:8321/api/sessions \
  -H 'Content-Type: application/json' \
  -d '{"prompt":"Refactor the auth module","name":"refactor-auth","cwd":"/home/user/myproject"}')

# 2. Get the Remote Control URL
echo $SESSION | jq -r '.rcUrl'
# → https://claude.ai/code/session_01UGdzwobzFGr9of2HMVJUuz

# 3. Open that URL in any browser or the Claude mobile app

# 4. When done, stop or remove
curl -X DELETE http://lab:8321/api/sessions/$(echo $SESSION | jq -r '.shortId')
```

## Scheduled jobs

CSM can run any prompt as a Claude session on a recurring cron schedule — useful for daily automations such as exporting Plaud transcripts, sending a Slack digest, or running any other skill at a fixed time.

Schedules are stored as JSON files under `~/.claude/csm-schedules/<id>.json` and are loaded into a cron engine at server startup. When a schedule fires, CSM creates a regular interactive session (same code path as a manually-created session) — so progress is visible from the normal dashboard and Remote Control.

### UI

Open `http://localhost:8321/schedules` (or click the **Schedules** link in the main dashboard header). The page is intentionally separate from the session dashboard.

You can pick a preset frequency (Daily / Weekly / Hourly) or write a custom 5-field cron expression. Each schedule has an enable toggle, "Run now" button, and an inline history of recent fires.

### API

| Method | Path | Description |
|--------|------|-------------|
| GET    | `/api/schedules` | List all schedules |
| POST   | `/api/schedules` | Create a schedule |
| GET    | `/api/schedules/:id` | Get a schedule |
| PUT    | `/api/schedules/:id` | Update a schedule (any subset of fields) |
| DELETE | `/api/schedules/:id` | Delete a schedule |
| POST   | `/api/schedules/:id/run` | Fire the schedule immediately, ignoring cron timing |

Schedule object fields: `id`, `name`, `cron` (5-field), `timezone` (default `Asia/Tokyo`), `prompt`, `cwd`, `model`, `enabled`, `nextRun`, `lastRun`, `history`.

```bash
curl -X POST http://localhost:8321/api/schedules \
  -H 'Content-Type: application/json' \
  -d '{
    "name": "Plaud daily sync",
    "cron": "0 9 * * *",
    "timezone": "Asia/Tokyo",
    "prompt": "/plaud-to-obsidian",
    "cwd": "/home/user/notes"
  }'
```

### Multi-node note

Each CSM node owns its own schedules — there is no host-side aggregation yet. Create the schedule on whichever node should run it.

## MCP Server

CSM includes an MCP (Model Context Protocol) server that lets Claude Code manage sessions directly.

### Setup

Add to your `~/.claude.json` (or `claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "claude-session-manager": {
      "command": "node",
      "args": ["/path/to/claude-session-manager/dist/mcp-cli.js"],
      "env": {
        "CSM_URL": "http://localhost:8321"
      }
    }
  }
}
```

Or with npx (after npm publish):

```json
{
  "mcpServers": {
    "claude-session-manager": {
      "command": "npx",
      "args": ["-y", "claude-session-manager-mcp"],
      "env": {
        "CSM_URL": "http://lab:8321"
      }
    }
  }
}
```

Set `CSM_URL` to the address of your running CSM server (e.g. `http://lab:8321` over Tailscale).

### Available Tools

| Tool | Description |
|------|-------------|
| `list_sessions` | List all managed sessions |
| `get_session` | Get details of a specific session |
| `create_session` | Create a new interactive Claude session with Remote Control |
| `stop_session` | Stop a running session |
| `remove_session` | Stop and remove a session |
| `respawn_session` | Re-create a stopped session |
| `get_logs` | Get session transcript |
| `refresh_rc_url` | Re-scan tmux pane for Remote Control URL |
| `list_schedules` | List all scheduled jobs |
| `get_schedule` | Get a scheduled job by UUID |
| `create_schedule` | Create a new scheduled job |
| `update_schedule` | Update fields of a scheduled job |
| `delete_schedule` | Delete a scheduled job |
| `run_schedule` | Fire a scheduled job immediately |
| `health` | Check CSM server status |

## Architecture

```
Browser / curl (Tailscale) → Hono server (0.0.0.0:8321) → tmux + claude CLI
                                  │
                                  ├── ~/.claude/sessions/     (native session registry)
                                  ├── ~/.claude/csm-sessions/ (CSM metadata)
                                  └── ~/.claude/projects/     (JSONL transcripts)
```

Session lifecycle:
1. `tmux new-session` → launches `claude --session-id <uuid> --remote-control <name>`
2. Initial prompt sent via `tmux send-keys`
3. RC URL captured from tmux pane output
4. Stop = `tmux kill-session`
5. State detection = PID liveness check + tmux has-session

## Configuration

Copy `csm.config.example.toml` to `csm.config.toml` and edit as needed. The config file is gitignored.

Configuration priority (highest wins):
1. Environment variables (`HOST`, `PORT`, `CLAUDE_CONFIG_DIR`, `CSM_MODE`)
2. `csm.config.toml` in project root
3. Built-in defaults (auto-detects binary paths from `$PATH`)

### Service management

```bash
systemctl --user status csm       # check status
systemctl --user stop csm         # stop
systemctl --user start csm        # start
systemctl --user restart csm      # restart
systemctl --user enable csm       # enable auto-start
systemctl --user disable csm      # disable auto-start
journalctl --user -u csm -f       # follow logs
```

### Multi-node mode

CSM supports aggregating sessions from multiple machines into a single dashboard. Each machine runs its own CSM instance, and one machine is designated as the **host** that collects sessions from all **client** nodes.

On each machine, install and start CSM as a systemd service:

```bash
git clone https://github.com/dakesan/claude-session-manager.git
cd claude-session-manager
npm install && npm run build
node dist/cli.js install-service
loginctl enable-linger $USER
```

On the host machine, configure `csm.config.toml`:

```toml
[server]
host = "0.0.0.0"
port = 8321
mode = "host"

[[remotes]]
name = "lab-server"
url = "http://192.168.1.10:8321"

[[remotes]]
name = "dev-machine"
url = "http://192.168.1.20:8321"
```

Client machines can use `mode = "client"` or the default `"standalone"`. No additional configuration is needed on clients.

How it works:
- The host's `/api/sessions` merges local sessions with all remote sessions
- Each session carries a `node` field indicating which machine it belongs to
- Stop, respawn, remove, and log operations are proxied to the correct node
- New sessions can be created on any node via the target node selector in the UI
- Node health and session counts are available at `GET /api/nodes`

Nodes must be reachable from the host. Recommended: **Tailscale** for secure, zero-config networking. No authentication is implemented — rely on network-level security.

## License

MIT
