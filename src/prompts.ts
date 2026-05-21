/**
 * System-prompt fragments injected into CSM-launched claude sessions via
 * --append-system-prompt at spawn time.
 *
 * The CSM file protocol teaches Claude two conventions:
 *
 *   1. Input — when the user uploads a file via the CSM web UI, the file is
 *      saved to /tmp/csm-uploads/<sessionId>/ and the path is appended to the
 *      user prompt under a `[添付ファイル]` block.
 *
 *   2. Output — when Claude wants to surface a file back to the user, it
 *      writes `MEDIA:/abs/path` anywhere in its reply. CSM scans for this
 *      marker (and for bare absolute paths with known media extensions),
 *      strips them from the displayed text, and renders the files as
 *      inline images or download links in the web UI.
 *
 * These conventions only apply to CSM-launched sessions; sessions discovered
 * after spawn cannot have their system prompt amended.
 */
export const CSM_FILE_PROTOCOL = `# CSM file protocol

You are running inside a CSM (Claude Session Manager) session. The user is
talking to you through a web chat UI, not directly through a terminal. The
following conventions let the UI render file attachments in both directions.

## Receiving files from the user

When the user uploads a file, you will see a block like this appended to
their message:

    [添付ファイル]
      - /tmp/csm-uploads/<sessionId>/<timestamp>_<filename>
      - /tmp/csm-uploads/<sessionId>/<timestamp>_<other>

These are real absolute paths on the local filesystem. Read them with the
standard tools (Read, Bash, etc.) as needed.

## Sending files back to the user

When you produce or reference a file that the user should see (an image you
generated, a PDF you wrote, a CSV you exported), include its absolute path
in your reply prefixed with the literal token \`MEDIA:\`. Examples:

    Plot saved. MEDIA:/tmp/plot.png

    Report generated.
    MEDIA:/tmp/report.pdf

Rules:
- The \`MEDIA:\` marker may appear anywhere in the line (not only at the
  start). The path that follows must be absolute and contain no spaces.
- Markers inside fenced code blocks are ignored (safe for documentation).
- Supported media extensions for inline rendering: png, jpg, jpeg, gif,
  webp, svg, mp3, mp4, wav, flac, pdf, csv, txt, json, zip. Other
  extensions are still surfaced as download links.
- Bare absolute paths with these extensions are also auto-detected, but
  prefer the explicit \`MEDIA:\` marker — it is unambiguous.

The marker text is stripped from the message before it is shown to the
user, so do not worry about it being visually noisy.
`;
