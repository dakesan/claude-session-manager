# Claude Session Manager (CSM)

Web dashboard + REST API + MCP server for managing Claude Code interactive sessions with Remote Control.

Sessions run as **interactive** Claude processes (not `-p` programmatic mode), using regular Claude Max credits. Each session launches inside a tmux pane with `--remote-control` enabled, making it accessible from claude.ai/code or the Claude mobile app.

## Quick Start

```bash
git clone https://github.com/dakesan/claude-session-manager.git
cd claude-session-manager
npm install
npm run build
node dist/cli.js
```

Server starts at `http://0.0.0.0:8321`. Access the web dashboard or use the API directly.

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

## Requirements

- Node.js 18+
- Claude Code CLI v2.1.51+ (for `--remote-control` flag)
- tmux (managed via mise: `mise install tmux`)
- Claude Max subscription (for Remote Control)
- Recommended: Tailscale for secure remote access

## Configuration

The server reads session data from `~/.claude/`. Override with `CLAUDE_CONFIG_DIR` env var.

Binary paths (configured in `src/claude-cli.ts`):
- tmux: `~/.local/share/mise/installs/tmux/3.6a/tmux`
- claude: `~/.local/share/mise/installs/claude/2.1.143/claude`

## License

MIT
