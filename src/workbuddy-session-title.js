"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const {
  createJsonlSessionTitleTracker,
  normalizeSessionTitle,
} = require("./jsonl-session-title");

const TITLE_POLL_MS = 2000;
const MAX_SESSIONS = 256;
const MAX_DB_TITLE_BYTES = 4096;

function workBuddyDataDirs(options = {}) {
  const home = options.homeDir || os.homedir();
  const configured = (options.env || process.env).WORKBUDDY_CONFIG_DIR;
  return [...new Set([
    typeof configured === "string" && path.isAbsolute(configured.trim()) ? configured.trim() : null,
    path.join(home, ".workbuddy-ai"),
    path.join(home, ".workbuddy"),
  ].filter(Boolean))];
}

function sameCwd(a, b) {
  if (!a || !b) return true;
  const normalize = (value) => {
    // WorkBuddy stores Windows paths with either separator spelling.
    const result = path.normalize(value).replace(/\\/g, "/").replace(/\/$/, "");
    return process.platform === "win32" ? result.toLowerCase() : result;
  };
  return normalize(a) === normalize(b);
}

function openReadOnlyDatabase(filePath) {
  const { DatabaseSync } = require("node:sqlite");
  return new DatabaseSync(filePath, { readOnly: true });
}

function readWorkBuddyDatabaseTitle(input, options = {}) {
  if (typeof input.rawSessionId !== "string" || !input.rawSessionId.trim()) return null;
  const dirs = [...(options.dataDirs || workBuddyDataDirs(options))];
  // When both generations are installed, prefer the home owning this transcript.
  dirs.sort((a, b) => {
    const owns = (dir) => input.transcriptPath && !path.relative(path.join(dir, "projects"), input.transcriptPath).startsWith("..")
      && !path.isAbsolute(path.relative(path.join(dir, "projects"), input.transcriptPath));
    return Number(!!owns(b)) - Number(!!owns(a));
  });
  const openDatabase = options.openDatabase || openReadOnlyDatabase;
  for (const dir of dirs) {
    const filePath = path.join(dir, "workbuddy.db");
    let db;
    try {
      // readOnly alone throws on absent files; don't create a WorkBuddy home.
      if (!fs.existsSync(filePath)) continue;
      db = openDatabase(filePath);
      const row = db.prepare(
        "SELECT title, custom_title, cwd FROM sessions WHERE id = ? AND deleted_at IS NULL "
        + "AND (title IS NULL OR length(CAST(title AS BLOB)) <= ?) "
        + "AND (custom_title IS NULL OR length(CAST(custom_title AS BLOB)) <= ?)",
      ).get(input.rawSessionId, MAX_DB_TITLE_BYTES, MAX_DB_TITLE_BYTES);
      if (!row || !sameCwd(input.cwd, row.cwd)) continue;
      const title = normalizeSessionTitle(row.custom_title) || normalizeSessionTitle(row.title);
      if (title) return title;
    } catch {
      // Older Node, locked/corrupt DBs, or unknown schemas use JSONL instead.
    } finally {
      if (db) { try { db.close(); } catch {} }
    }
  }
  return null;
}

function createWorkBuddySessionTitleTracker(options = {}) {
  const entries = new Map();
  const getSession = options.getSession || (() => null);
  const updateTitle = options.updateTitle || (() => {});
  const jsonl = createJsonlSessionTitleTracker({ maxScanBytes: 1024 * 1024 });
  const readTitle = options.readTitle || (async (entry) => {
    const title = readWorkBuddyDatabaseTitle(entry, options);
    if (title) return title;
    if (!entry.transcriptPath) return null;
    return jsonl.resolve({
      event: "Stop", sessionId: entry.rawSessionId, transcriptPath: entry.transcriptPath,
    });
  });
  let timer = null;

  function clear(sessionId = null) {
    if (sessionId === null) {
      entries.clear();
      jsonl.clear();
    } else {
      const entry = entries.get(sessionId);
      if (entry) jsonl.clear(entry.rawSessionId);
      entries.delete(sessionId);
    }
    if (!entries.size && timer) {
      clearInterval(timer);
      timer = null;
    }
  }

  async function refresh(entry) {
    if (entry.pending) return entry.pending;
    const live = getSession(entry.sessionId);
    if (!live) { clear(entry.sessionId); return; }
    entry.pending = (async () => {
      try {
        const title = await readTitle(entry);
        // SessionEnd, disable/uninstall, same-id resume, and late async reads
        // cannot annotate another lifecycle or create a phantom HUD row.
        if (title && entries.get(entry.sessionId) === entry
          && getSession(entry.sessionId) === live) updateTitle(entry.sessionId, title);
      } catch {} // Title discovery never breaks state delivery.
    })();
    try { await entry.pending; }
    finally { entry.pending = null; }
  }

  async function poll() {
    await Promise.all([...entries.values()].map(refresh));
  }

  function track(input) {
    const previous = entries.get(input.sessionId);
    let entry = previous;
    if (!entry || entry.rawSessionId !== input.rawSessionId || entry.cwd !== input.cwd
      || entry.transcriptPath !== input.transcriptPath) {
      clear(input.sessionId);
      entry = { ...input, pending: null };
    }
    entries.delete(input.sessionId);
    entries.set(input.sessionId, entry);
    while (entries.size > MAX_SESSIONS) clear(entries.keys().next().value);
    if (!timer) {
      timer = setInterval(() => { void poll(); }, options.pollMs || TITLE_POLL_MS);
      timer.unref?.();
    }
    void refresh(entry);
  }

  return { track, clear, poll, size: () => entries.size };
}

module.exports = {
  TITLE_POLL_MS,
  workBuddyDataDirs,
  readWorkBuddyDatabaseTitle,
  createWorkBuddySessionTitleTracker,
};
