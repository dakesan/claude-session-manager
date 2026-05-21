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

/**
 * Parse the `[添付ファイル]` block emitted by the message endpoint when a user
 * upload accompanies a prompt. The block has the literal shape:
 *
 *     <user prompt>\n\n[添付ファイル]\n  - /abs/path\n  - /abs/path
 *
 * Returns the cleaned text (with the block removed) and the list of paths
 * that actually exist on disk. If the block is absent the original text is
 * returned with paths=[].
 */
export function extractAttachmentBlock(text: string): { text: string; paths: string[] } {
  if (!text || !text.includes("[添付ファイル]")) {
    return { text, paths: [] };
  }
  const blockPattern = /\n*\[添付ファイル\]\n((?:[ \t]*-[ \t]+\/[^\n]+\n?)+)/;
  const m = blockPattern.exec(text);
  if (!m) return { text, paths: [] };
  const lines = m[1].split("\n");
  const paths: string[] = [];
  for (const line of lines) {
    const lm = /^[ \t]*-[ \t]+(\/[^\s]+)/.exec(line);
    if (!lm) continue;
    const p = lm[1];
    if (existsSync(p)) paths.push(p);
  }
  const cleaned = text.replace(blockPattern, "").trim();
  return { text: cleaned, paths };
}
