"""FastAPI application for Claude Session Manager."""

from pathlib import Path

from fastapi import FastAPI, HTTPException
from fastapi.responses import FileResponse, HTMLResponse
from pydantic import BaseModel

from . import claude_cli

STATIC_DIR = Path(__file__).resolve().parent.parent.parent / "static"

app = FastAPI(title="Claude Session Manager", version="0.1.0")


class CreateSessionRequest(BaseModel):
    """Request body for creating a new session."""

    prompt: str
    name: str | None = None
    cwd: str | None = None


class SessionResponse(BaseModel):
    """Response model for a session."""

    short_id: str
    session_id: str | None = None
    name: str | None = None
    state: str
    prompt: str | None = None
    cwd: str | None = None
    remote_control_url: str | None = None
    created_at: str | None = None


def _session_to_response(session: claude_cli.Session) -> SessionResponse:
    return SessionResponse(
        short_id=session.short_id,
        session_id=session.session_id,
        name=session.name,
        state=session.state.value,
        prompt=session.prompt,
        cwd=session.cwd,
        remote_control_url=session.remote_control_url,
        created_at=session.created_at,
    )


@app.get("/api/sessions", response_model=list[SessionResponse])
async def list_sessions():
    """List all background sessions."""
    sessions = claude_cli.list_sessions()
    return [_session_to_response(s) for s in sessions]


@app.get("/api/sessions/{short_id}", response_model=SessionResponse)
async def get_session(short_id: str):
    """Get a single session by short ID."""
    session = claude_cli.get_session(short_id)
    if not session:
        raise HTTPException(status_code=404, detail=f"Session {short_id} not found")
    return _session_to_response(session)


@app.post("/api/sessions", response_model=SessionResponse, status_code=201)
async def create_session(req: CreateSessionRequest):
    """Create a new background session."""
    try:
        session = await claude_cli.create_session(
            prompt=req.prompt,
            name=req.name,
            cwd=req.cwd,
        )
        return _session_to_response(session)
    except RuntimeError as e:
        raise HTTPException(status_code=500, detail=str(e))


@app.post("/api/sessions/{short_id}/stop")
async def stop_session(short_id: str):
    """Stop a background session."""
    success = await claude_cli.stop_session(short_id)
    if not success:
        raise HTTPException(status_code=500, detail=f"Failed to stop session {short_id}")
    return {"status": "stopped", "short_id": short_id}


@app.post("/api/sessions/{short_id}/respawn")
async def respawn_session(short_id: str):
    """Respawn a stopped session."""
    success = await claude_cli.respawn_session(short_id)
    if not success:
        raise HTTPException(status_code=500, detail=f"Failed to respawn session {short_id}")
    return {"status": "respawned", "short_id": short_id}


@app.delete("/api/sessions/{short_id}")
async def remove_session(short_id: str):
    """Remove a session."""
    success = await claude_cli.remove_session(short_id)
    if not success:
        raise HTTPException(status_code=500, detail=f"Failed to remove session {short_id}")
    return {"status": "removed", "short_id": short_id}


@app.get("/api/sessions/{short_id}/logs")
async def get_logs(short_id: str):
    """Get recent logs for a session."""
    logs = await claude_cli.get_logs(short_id)
    return {"short_id": short_id, "logs": logs}


@app.get("/api/roster")
async def get_roster():
    """Get the daemon roster."""
    return claude_cli.get_roster()


@app.get("/", response_class=HTMLResponse)
async def index():
    """Serve the frontend."""
    return FileResponse(STATIC_DIR / "index.html")
