"""Wrapper around Claude Code CLI for session management."""

import asyncio
import json
import os
from dataclasses import dataclass, field
from enum import Enum
from pathlib import Path


class SessionState(str, Enum):
    """Session states as defined by Claude Code Agent View."""

    WORKING = "working"
    NEEDS_INPUT = "needs_input"
    IDLE = "idle"
    COMPLETED = "completed"
    FAILED = "failed"
    STOPPED = "stopped"
    UNKNOWN = "unknown"


@dataclass
class Session:
    """Represents a Claude Code background session."""

    short_id: str
    session_id: str | None = None
    name: str | None = None
    state: SessionState = SessionState.UNKNOWN
    prompt: str | None = None
    cwd: str | None = None
    remote_control_url: str | None = None
    created_at: str | None = None
    raw: dict = field(default_factory=dict)


def get_claude_dir() -> Path:
    """Get the Claude config directory."""
    config_dir = os.environ.get("CLAUDE_CONFIG_DIR")
    if config_dir:
        return Path(config_dir)
    return Path.home() / ".claude"


def list_sessions() -> list[Session]:
    """List all background sessions by reading ~/.claude/jobs/."""
    jobs_dir = get_claude_dir() / "jobs"
    if not jobs_dir.exists():
        return []

    sessions = []
    for job_dir in sorted(jobs_dir.iterdir()):
        if not job_dir.is_dir():
            continue

        short_id = job_dir.name
        state_file = job_dir / "state.json"

        session = Session(short_id=short_id)

        if state_file.exists():
            try:
                data = json.loads(state_file.read_text())
                session.session_id = data.get("sessionId")
                session.name = data.get("name")
                session.state = _parse_state(data.get("state", ""))
                session.prompt = data.get("prompt")
                session.cwd = data.get("cwd")
                session.created_at = data.get("createdAt")
                session.raw = data
            except (json.JSONDecodeError, OSError):
                pass

        sessions.append(session)

    return sessions


def get_session(short_id: str) -> Session | None:
    """Get a single session by short ID."""
    job_dir = get_claude_dir() / "jobs" / short_id
    if not job_dir.exists():
        return None

    session = Session(short_id=short_id)
    state_file = job_dir / "state.json"

    if state_file.exists():
        try:
            data = json.loads(state_file.read_text())
            session.session_id = data.get("sessionId")
            session.name = data.get("name")
            session.state = _parse_state(data.get("state", ""))
            session.prompt = data.get("prompt")
            session.cwd = data.get("cwd")
            session.created_at = data.get("createdAt")
            session.raw = data
        except (json.JSONDecodeError, OSError):
            pass

    return session


def get_roster() -> dict:
    """Read the daemon roster for active session info."""
    roster_file = get_claude_dir() / "daemon" / "roster.json"
    if not roster_file.exists():
        return {}
    try:
        return json.loads(roster_file.read_text())
    except (json.JSONDecodeError, OSError):
        return {}


async def create_session(prompt: str, name: str | None = None, cwd: str | None = None) -> Session:
    """Create a new background session via `claude --bg`."""
    cmd = ["claude", "--bg"]
    if name:
        cmd.extend(["--name", name])
    cmd.append(prompt)

    proc = await asyncio.create_subprocess_exec(
        *cmd,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
        cwd=cwd,
    )
    stdout, stderr = await proc.communicate()
    output = stdout.decode()

    # Parse short ID from output: "backgrounded · 7c5dcf5d"
    short_id = _parse_bg_output(output)
    if not short_id:
        raise RuntimeError(f"Failed to parse session ID from output: {output}\nstderr: {stderr.decode()}")

    # Read the created session state
    session = get_session(short_id)
    if session:
        return session

    return Session(short_id=short_id, prompt=prompt, name=name)


async def stop_session(short_id: str) -> bool:
    """Stop a background session."""
    proc = await asyncio.create_subprocess_exec(
        "claude", "stop", short_id,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
    )
    await proc.communicate()
    return proc.returncode == 0


async def respawn_session(short_id: str) -> bool:
    """Respawn a stopped session."""
    proc = await asyncio.create_subprocess_exec(
        "claude", "respawn", short_id,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
    )
    await proc.communicate()
    return proc.returncode == 0


async def remove_session(short_id: str) -> bool:
    """Remove a session."""
    proc = await asyncio.create_subprocess_exec(
        "claude", "rm", short_id,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
    )
    await proc.communicate()
    return proc.returncode == 0


async def get_logs(short_id: str) -> str:
    """Get recent logs for a session."""
    proc = await asyncio.create_subprocess_exec(
        "claude", "logs", short_id,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
    )
    stdout, _ = await proc.communicate()
    return stdout.decode()


def _parse_state(state_str: str) -> SessionState:
    """Parse state string to SessionState enum."""
    state_map = {
        "working": SessionState.WORKING,
        "needs_input": SessionState.NEEDS_INPUT,
        "idle": SessionState.IDLE,
        "completed": SessionState.COMPLETED,
        "failed": SessionState.FAILED,
        "stopped": SessionState.STOPPED,
    }
    return state_map.get(state_str.lower(), SessionState.UNKNOWN)


def _parse_bg_output(output: str) -> str | None:
    """Parse short ID from `claude --bg` output.

    Expected format: "backgrounded · 7c5dcf5d"
    """
    for line in output.splitlines():
        line = line.strip()
        if "backgrounded" in line and "·" in line:
            parts = line.split("·")
            if len(parts) >= 2:
                return parts[-1].strip()
    return None
