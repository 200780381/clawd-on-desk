"use strict";

// Main-process reader for the durable session history store.
//
// hooks/session-history.js owns the on-disk format and stays dependency-free
// so it can run inside a hook. This module adds the two things only the main
// process can know: which sessions are already on screen, and whether Claude
// Code still holds a transcript for a row we are about to offer to resume.

const fs = require("fs");
const os = require("os");
const path = require("path");
const { loadSessionHistory, normalizeClaudeProfile } = require("../hooks/session-history");
const { normalizeClaudeSessionId } = require("../hooks/claude-session-id");
const { extractPromptTitle } = require("../hooks/cursor-session-title");

const DEFAULT_HISTORY_LIMIT = 25;

// Claude Code stores transcripts at
//   ~/.claude/projects/<encoded cwd>/<sessionId>.jsonl
// where the encoding replaces every character outside [A-Za-z0-9-] with "-".
// The mapping is lossy and therefore one-way, which is all a lookup needs.
function encodeClaudeProjectDir(cwd) {
  if (typeof cwd !== "string" || !cwd) return null;
  return cwd.replace(/[^A-Za-z0-9-]/g, "-");
}

function getClaudeProjectsDir(profile, options = {}) {
  const normalizedProfile = normalizeClaudeProfile(profile);
  if (!normalizedProfile) return null;
  if (normalizedProfile.kind === "default") {
    if (typeof options.claudeProjectsDir === "string" && options.claudeProjectsDir) {
      return path.resolve(options.claudeProjectsDir);
    }
    return path.join(os.homedir(), ".claude", "projects");
  }
  return path.join(normalizedProfile.configDir, "projects");
}

/**
 * Does Claude Code still hold a transcript for this row?
 *
 * Deliberately fails open. The directory layout above is Claude Code's private
 * detail, so an unrecognized shape must read as "unknown", never as "gone" —
 * hiding a session the user could actually resume is the worse error. Only a
 * present project directory with the transcript absent is a confident no.
 *
 * Returns true (present), false (confidently missing), or null (unknown).
 */
function probeTranscript(agentId, sessionId, cwd, profile, options = {}) {
  if (agentId !== "claude-code") return null;
  try {
    if (!sessionId || normalizeClaudeSessionId(sessionId) !== sessionId) return null;
  } catch { return null; }
  const dirName = encodeClaudeProjectDir(cwd);
  if (!dirName) return null;
  const projectsDir = getClaudeProjectsDir(profile, options);
  if (!projectsDir) return null;
  const projectDir = path.join(projectsDir, dirName);
  try {
    const stat = fs.lstatSync(projectDir);
    if (!stat.isDirectory() || stat.isSymbolicLink()) return null;
  } catch {
    return null; // no such project dir — cannot tell, so do not claim.
  }
  try {
    const transcript = path.join(projectDir, `${sessionId}.jsonl`);
    const stat = fs.lstatSync(transcript);
    return stat.isFile() && !stat.isSymbolicLink() && stat.size > 0;
  } catch (err) {
    return err && err.code === "ENOENT" ? false : null;
  }
}

/**
 * History rows ready for the Dashboard's resume list.
 *
 * Sessions already present in the live snapshot are filtered out: the
 * Dashboard shows those in its own list, and offering "resume" for a
 * conversation that is running would invite a duplicate process.
 */
function loadResumableSessionHistory(options = {}) {
  const limit = Number.isFinite(options.limit) && options.limit > 0
    ? options.limit
    : DEFAULT_HISTORY_LIMIT;
  const activeRawSessionIds = options.activeRawSessionIds instanceof Set
    ? options.activeRawSessionIds
    : new Set();

  // Over-read, because the active filter below removes rows after ranking.
  const records = loadSessionHistory({ ...options, limit: limit + activeRawSessionIds.size });

  const rows = [];
  for (const record of records) {
    if (activeRawSessionIds.has(record.sessionId)) continue;
    const profileVerified = record.version >= 2 && !!normalizeClaudeProfile(record.profile);
    const transcript = profileVerified
      ? probeTranscript(record.agentId, record.sessionId, record.cwd, record.profile, options)
      : null;
    let title = record.title || null;
    if (!title && transcript === true) {
      const transcriptPath = transcriptPathFor(
        record.sessionId, record.cwd, record.profile, options,
      );
      if (transcriptPath) title = extractTitleFromTranscript(transcriptPath);
    }
    rows.push({
      agentId: record.agentId,
      sessionId: record.sessionId,
      historyKey: record.historyKey,
      cwd: record.cwd,
      title,
      lastState: record.lastState,
      firstSeenAt: record.firstSeenAt,
      lastEventAt: record.lastEventAt,
      endedAt: record.endedAt,
      interrupted: record.interrupted,
      // null means "could not determine" — the row is still offered.
      transcriptPresent: transcript,
      resumeDisabledReason: profileVerified ? null : "profile-unverified",
    });
    if (rows.length >= limit) break;
  }
  return rows;
}

/**
 * Most sessions never carry a title in their hook payloads, so the resume
 * list shows opaque session ids. The first thing the user actually typed
 * names the session better than anything else clawd has: read it from the
 * transcript's head — a growing window with a hard cap, never the whole
 * file — and only for rows whose transcript the probe already confirmed,
 * because a vanished file has nothing to name. The prompt-to-title rule
 * is exactly the live one (extractPromptTitle): first non-empty line, no
 * title when that line is secret-shaped, capped at 40 chars.
 */
// Dashboard refreshes re-run extraction for the same unchanged files; the
// cache makes the second pass cost one stat per transcript. A null result is
// cached too: "could not name it" will not change until the file does.
const titleCache = new Map();

function clearTitleExtractionCache() {
  titleCache.clear();
}

function extractTitleFromTranscript(transcriptPath) {
  let stat;
  try {
    stat = fs.statSync(transcriptPath);
  } catch {
    return null;
  }
  const cacheKey = `${stat.mtimeMs}:${stat.size}`;
  const cached = titleCache.get(transcriptPath);
  if (cached && cached.key === cacheKey) return cached.title;
  let title = null;
  try {
    title = readTitleFromTranscript(transcriptPath, stat.size);
  } catch {
    // Transcript lines are Claude Code's private shape; one malformed row
    // must never take the whole resume list down with it.
    title = null;
  }
  titleCache.set(transcriptPath, { key: cacheKey, title });
  return title;
}

function readTitleFromTranscript(transcriptPath, size) {
  let command = null; // first slash command, the fallback if no prompt is real
  for (const window of [16 * 1024, 64 * 1024, 256 * 1024, 1024 * 1024]) {
    const read = Math.min(window, size);
    let text;
    try {
      const fd = fs.openSync(transcriptPath, "r");
      const buf = Buffer.alloc(read);
      fs.readSync(fd, buf, 0, read, 0);
      fs.closeSync(fd);
      text = buf.toString("utf8");
    } catch {
      return null;
    }
    for (const line of text.split("\n")) {
      if (!line.trim()) continue;
      let entry;
      try {
        entry = JSON.parse(line);
      } catch {
        continue; // a line cut off by the window, or a huge single record
      }
      if (!entry || entry.type !== "user" || entry.isMeta || entry.isSidechain) continue;
      const content = entry.message && entry.message.content;
      // A real tool result is a typed block in the content array; a user who
      // merely types the word "tool_result" is not one.
      if (Array.isArray(content)
        && content.some((part) => part && part.type === "tool_result")) continue;
      const raw = typeof content === "string" ? content
        : Array.isArray(content)
          ? (content.find((part) => part && part.type === "text") || {}).text || ""
          : "";
      const clean = String(raw).trim();
      const slash = clean.match(/^<command-message>([\w:-]+)/);
      if (slash) {
        if (!command) command = `/${slash[1]}`;
        continue;
      }
      if (clean.startsWith("<")) continue; // other machine-generated wrappers
      // The live prompt-title rule (extractPromptTitle): first non-empty line,
      // no title when that line is secret-shaped, capped at 40 chars. The
      // verdict is final — a secret opening line means "no safe name", not
      // "keep looking at later prompts".
      return extractPromptTitle(clean);
    }
    if (read >= size) return command; // whole file scanned, no plain prompt
  }
  return command; // head capped short of the file end; keep the command found
}

function transcriptPathFor(sessionId, cwd, profile, options = {}) {
  const dirName = encodeClaudeProjectDir(cwd);
  const projectsDir = dirName && getClaudeProjectsDir(profile, options);
  return projectsDir ? path.join(projectsDir, dirName, `${sessionId}.jsonl`) : null;
}

/**
 * Resolve a resume request coming from the Dashboard back to a trusted row.
 *
 * The renderer sends only an agent id and opaque history key. Everything the launcher
 * acts on — above all the working directory — is read back from the store here
 * rather than taken from the message, so a renderer cannot choose the folder a
 * session is relaunched in.
 */
function resolveResumeTarget(agentId, historyKey, options = {}) {
  if (agentId !== "claude-code" || typeof historyKey !== "string"
    || !/^[a-f0-9]{32}$/.test(historyKey)) return null;
  const records = loadSessionHistory({ ...options, limit: undefined });
  const match = records.find(
    (record) => record.agentId === agentId && record.historyKey === historyKey,
  );
  if (!match) return null;
  const profile = match.version >= 2 ? normalizeClaudeProfile(match.profile) : null;
  if (!profile) return null;
  if (!match.cwd || !path.isAbsolute(match.cwd)) return null;
  try {
    const stat = fs.lstatSync(match.cwd);
    if (!stat.isDirectory()) return null;
  } catch {
    return null; // the project folder is gone; resuming there would fail anyway.
  }
  return {
    agentId: match.agentId,
    sessionId: match.sessionId,
    historyKey: match.historyKey,
    cwd: match.cwd,
    profile,
  };
}

module.exports = {
  DEFAULT_HISTORY_LIMIT,
  encodeClaudeProjectDir,
  getClaudeProjectsDir,
  probeTranscript,
  loadResumableSessionHistory,
  clearTitleExtractionCache,
  resolveResumeTarget,
};
