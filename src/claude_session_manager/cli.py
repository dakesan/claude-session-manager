"""CLI entry point for Claude Session Manager."""

import typer
import uvicorn

app = typer.Typer(help="Claude Session Manager - Web UI for Claude Code sessions")


@app.command()
def serve(
    host: str = typer.Option("0.0.0.0", help="Bind address"),
    port: int = typer.Option(8321, help="Port number"),
    reload: bool = typer.Option(False, help="Enable auto-reload for development"),
):
    """Start the session manager web server."""
    uvicorn.run(
        "claude_session_manager.api:app",
        host=host,
        port=port,
        reload=reload,
    )


if __name__ == "__main__":
    app()
