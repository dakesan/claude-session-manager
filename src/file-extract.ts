/**
 * Extract file paths from assistant output following the CSM file protocol.
 *
 *   - `MEDIA:/abs/path` markers (preferred, unambiguous)
 *   - Bare absolute paths ending in a known media/document/archive extension
 *
 * Matches inside fenced code blocks are intentionally ignored so the
 * protocol can be safely documented within Claude's own responses.
 */

import { existsSync } from "node:fs";

export const SUPPORTED_EXTENSIONS = [
  "png",
  "jpg",
  "jpeg",
  "gif",
  "webp",
  "svg",
  "mp3",
  "mp4",
  "wav",
  "flac",
  "pdf",
  "csv",
  "txt",
  "json",
  "zip",
] as const;

const EXT_PATTERN = SUPPORTED_EXTENSIONS.join("|");

/** Strip fenced code blocks (``` ... ```) so their content is ignored. */
function stripCodeBlocks(text: string): string {
  return text.replace(/```[\s\S]*?```/g, "");
}

/**
 * Return absolute paths referenced by the text via the protocol. Order is
 * preserved and duplicates are removed. Only paths whose file exists on the
 * local filesystem are returned — broken references are silently dropped.
 */
export function extractFilePaths(text: string): string[] {
  if (!text) return [];
  const scan = stripCodeBlocks(text);
  const seen = new Set<string>();
  const out: string[] = [];

  const mediaPattern = /MEDIA:\s*(\/[^\s\n]+)/g;
  let m: RegExpExecArray | null;
  while ((m = mediaPattern.exec(scan)) !== null) {
    const p = m[1].trim();
    if (!seen.has(p) && existsSync(p)) {
      seen.add(p);
      out.push(p);
    }
  }

  const absPattern = new RegExp(
    `(?:^|\\s)(/[^\\s]+\\.(?:${EXT_PATTERN}))(?=\\s|$|[.,;:)])`,
    "gim",
  );
  while ((m = absPattern.exec(scan)) !== null) {
    const p = m[1].trim();
    if (!seen.has(p) && existsSync(p)) {
      seen.add(p);
      out.push(p);
    }
  }

  return out;
}

/**
 * Remove the protocol markers from text so it can be displayed to the user
 * without `MEDIA:` noise. Bare absolute paths are NOT stripped: the user may
 * want to see them in context.
 */
export function stripFilePaths(text: string): string {
  return text
    .replace(/MEDIA:\s*\S+/g, "")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
