"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const {
  workBuddyDataDirs,
  readWorkBuddyDatabaseTitle,
  createWorkBuddySessionTitleTracker,
} = require("../src/workbuddy-session-title");
const { createJsonlSessionTitleTracker } = require("../src/jsonl-session-title");
const createAgentRuntimeMain = require("../src/agent-runtime-main");
const initState = require("../src/state");
const themeLoader = require("../src/theme-loader");

let DatabaseSync;
try { ({ DatabaseSync } = require("node:sqlite")); } catch {}
const nextTurn = () => new Promise((resolve) => setImmediate(resolve));

async function fixture(run) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "clawd-workbuddy-title-"));
  try { await run(home); }
  finally { fs.rmSync(home, { recursive: true, force: true }); }
}

function createDatabase(dir, rows) {
  fs.mkdirSync(dir, { recursive: true });
  const db = new DatabaseSync(path.join(dir, "workbuddy.db"));
  db.exec("CREATE TABLE sessions (id TEXT PRIMARY KEY, title TEXT, custom_title TEXT, cwd TEXT, deleted_at INTEGER)");
  const insert = db.prepare("INSERT INTO sessions VALUES (?, ?, ?, ?, ?)");
  for (const row of rows) insert.run(...row);
  db.close();
}

function hash(file) { return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex"); }

describe("WorkBuddy native title storage", () => {
  it("uses an absolute configured home and both desktop generations", () => {
    const home = path.resolve("fixture-home");
    const custom = path.resolve("custom-workbuddy");
    assert.deepEqual(workBuddyDataDirs({ homeDir: home, env: { WORKBUDDY_CONFIG_DIR: ` ${custom} ` } }),
      [custom, path.join(home, ".workbuddy-ai"), path.join(home, ".workbuddy")]);
    assert.equal(workBuddyDataDirs({ homeDir: home, env: { WORKBUDDY_CONFIG_DIR: "relative" } }).length, 2);
  });

  it("reads only the matching session, prefers custom names, and leaves bytes unchanged", { skip: !DatabaseSync }, async () => {
    await fixture(async (dir) => {
      createDatabase(dir, [["s1", "Generated name", "User renamed chat", "/project", null],
        ["other", "Wrong session", null, "/project", null]]);
      const file = path.join(dir, "workbuddy.db");
      const before = hash(file);
      assert.equal(readWorkBuddyDatabaseTitle({ rawSessionId: "s1", cwd: "/project" }, { dataDirs: [dir] }), "User renamed chat");
      assert.equal(readWorkBuddyDatabaseTitle({ rawSessionId: "s1", cwd: "/different" }, { dataDirs: [dir] }), null);
      assert.equal(readWorkBuddyDatabaseTitle({ rawSessionId: "s1' OR 1=1 --" }, { dataDirs: [dir] }), null);
      assert.equal(hash(file), before);
      // The read-only handle is closed, so the application can still write.
      const db = new DatabaseSync(file);
      db.prepare("UPDATE sessions SET custom_title = ? WHERE id = ?").run("Renamed again", "s1");
      db.close();
      assert.equal(readWorkBuddyDatabaseTitle({ rawSessionId: "s1" }, { dataDirs: [dir] }), "Renamed again");
    });
  });

  it("prefers the home owning the transcript and ignores deleted/oversized rows", { skip: !DatabaseSync }, async () => {
    await fixture(async (home) => {
      const current = path.join(home, ".workbuddy-ai");
      const legacy = path.join(home, ".workbuddy");
      createDatabase(current, [["s1", "Stale current home", null, "/project", null]]);
      createDatabase(legacy, [["s1", "Active legacy home", null, "/project", null],
        ["deleted", "Deleted", null, "/project", 1],
        ["large", "x".repeat(5000), null, "/project", null],
        ["custom-only", null, "Custom only", "/project", null]]);
      const options = { homeDir: home, env: {} };
      assert.equal(readWorkBuddyDatabaseTitle({ rawSessionId: "s1", transcriptPath: path.join(legacy, "projects", "p", "s1.jsonl") }, options), "Active legacy home");
      for (const rawSessionId of ["deleted", "large", "missing"]) {
        assert.equal(readWorkBuddyDatabaseTitle({ rawSessionId }, options), null);
      }
      assert.equal(readWorkBuddyDatabaseTitle({ rawSessionId: "custom-only" }, options), "Custom only");
    });
  });

  it("tolerates absent files, unavailable SQLite, and unknown/corrupt schemas", async () => {
    await fixture(async (dir) => {
      const options = { dataDirs: [dir], openDatabase: () => { throw new Error("unsupported SQLite"); } };
      assert.equal(readWorkBuddyDatabaseTitle({ rawSessionId: "s1" }, options), null);
      assert.deepEqual(fs.readdirSync(dir), []);
      fs.writeFileSync(path.join(dir, "workbuddy.db"), "not a database");
      assert.equal(readWorkBuddyDatabaseTitle({ rawSessionId: "s1" }, options), null);
      assert.equal(readWorkBuddyDatabaseTitle({ rawSessionId: "s1" }, { dataDirs: [dir] }), null);
    });
  });
});

describe("WorkBuddy title observer", () => {
  it("discovers delayed ai-title and custom-title without another hook", async () => {
    await fixture(async (dir) => {
      const transcriptPath = path.join(dir, "s1.jsonl");
      fs.writeFileSync(transcriptPath, `${JSON.stringify({ type: "message", content: "Prompt content must not be a native title" })}\n`);
      const session = {};
      const updates = [];
      const tracker = createWorkBuddySessionTitleTracker({ dataDirs: [dir], getSession: () => session,
        updateTitle: (id, title) => updates.push([id, title]), pollMs: 60_000 });
      try {
        tracker.track({ sessionId: "s1", rawSessionId: "s1", transcriptPath });
        await tracker.poll();
        assert.deepEqual(updates, []);
        fs.appendFileSync(transcriptPath, `${JSON.stringify({ type: "ai-title", sessionId: "other", aiTitle: "Wrong chat" })}\n`
          + `${JSON.stringify({ type: "ai-title", sessionId: "s1", aiTitle: "Generated chat name" })}\n`);
        await tracker.poll();
        assert.deepEqual(updates.at(-1), ["s1", "Generated chat name"]);
        fs.appendFileSync(transcriptPath, `${JSON.stringify({ type: "custom-title", sessionId: "s1", customTitle: "Renamed chat" })}\n`
          + `${JSON.stringify({ type: "ai-title", sessionId: "s1", aiTitle: "Later generation" })}\n`);
        await tracker.poll();
        assert.deepEqual(updates.at(-1), ["s1", "Renamed chat"]);
      } finally { tracker.clear(); }
    });
  });

  it("bounds each JSONL scan while eventually reaching a late title", async () => {
    await fixture(async (dir) => {
      const transcriptPath = path.join(dir, "s1.jsonl");
      fs.writeFileSync(transcriptPath, `${JSON.stringify({ type: "message", content: "x".repeat(150_000) })}\n`
        + `${JSON.stringify({ type: "ai-title", sessionId: "s1", aiTitle: "Late native name" })}\n`);
      const scans = [];
      const reader = createJsonlSessionTitleTracker({ maxScanBytes: 64 * 1024, onScan: (scan) => scans.push(scan) });
      try {
        const input = { event: "Stop", sessionId: "s1", transcriptPath };
        assert.equal(await reader.resolve(input), null);
        assert.equal(await reader.resolve(input), null);
        assert.equal(await reader.resolve(input), "Late native name");
        assert.ok(scans.every((scan) => scan.contentBytesRead <= 64 * 1024));
      } finally { reader.clear(); }
    });
  });

  it("serializes overlapping polls and discards reads after end, resume, or disable", async () => {
    for (const action of ["end", "resume", "disable"]) {
      const resolvers = [];
      let reads = 0;
      let session = {};
      const updates = [];
      const tracker = createWorkBuddySessionTitleTracker({ getSession: () => session,
        updateTitle: (...args) => updates.push(args), pollMs: 60_000,
        readTitle: () => { reads++; return new Promise((done) => { resolvers.push(done); }); } });
      try {
        tracker.track({ sessionId: "s1", rawSessionId: "s1" });
        const pending = tracker.poll();
        assert.equal(reads, 1);
        if (action === "disable") session = null;
        else {
          tracker.clear("s1");
          if (action === "resume") { session = {}; tracker.track({ sessionId: "s1", rawSessionId: "s1" }); }
        }
        resolvers[0]("Old name");
        await pending;
        assert.deepEqual(updates, []);
        if (action === "resume") {
          resolvers[1]("Resumed name");
          await tracker.poll();
          assert.deepEqual(updates, [["s1", "Resumed name"]]);
        }
        if (action === "disable") { await tracker.poll(); assert.equal(tracker.size(), 0); }
      } finally { tracker.clear(); }
    }
  });
});

describe("WorkBuddy native names through the runtime and snapshots", () => {
  it("keeps real names across follow-up prompts, observes idle renames, and never refreshes activity", { skip: !DatabaseSync }, async () => {
    await fixture(async (dir) => {
      createDatabase(dir, [["s1", "Actual WorkBuddy chat", null, "/project", null]]);
      themeLoader.init(path.join(__dirname, "..", "src"));
      const state = initState({ theme: themeLoader.loadTheme("clawd"), lang: "en", pendingPermissions: [],
        playSound() {}, sendToRenderer() {}, syncHitWin() {}, sendToHitWin() {}, buildContextMenu() {}, buildTrayMenu() {},
        getCursorScreenPoint: () => ({ x: 0, y: 0 }), mouseStillSince: Date.now(), getSessionAliases: () => ({}) });
      let enabled = true;
      const runtime = createAgentRuntimeMain({ updateSession: state.updateSession, getStateRuntime: () => state,
        isAgentEnabled: () => enabled, workBuddySessionTitleOptions: { dataDirs: [dir], pollMs: 20 } });
      const update = (event, title) => runtime.updateSessionFromServer("s1", event === "Stop" ? "attention" : "thinking", event,
        { agentId: "workbuddy", profileId: "local", rawSessionId: "s1", cwd: "/project", sessionTitle: title, sessionTitleFromPrompt: true });
      const waitFor = async (test) => {
        const until = Date.now() + 2000;
        while (!test() && Date.now() < until) await new Promise((done) => setTimeout(done, 5));
        assert.ok(test());
      };
      try {
        update("UserPromptSubmit", "Prompt text");
        await waitFor(() => state.sessions.get("s1").sessionTitle === "Actual WorkBuddy chat");
        update("UserPromptSubmit", "Different follow-up content");
        assert.equal(state.sessions.get("s1").sessionTitle, "Actual WorkBuddy chat");
        update("Stop");
        const before = { updatedAt: state.sessions.get("s1").updatedAt, state: state.sessions.get("s1").state,
          event: state.sessions.get("s1").event };
        const db = new DatabaseSync(path.join(dir, "workbuddy.db"));
        db.prepare("UPDATE sessions SET custom_title=? WHERE id=?").run("Renamed while idle", "s1");
        db.close();
        await waitFor(() => state.sessions.get("s1").sessionTitle === "Renamed while idle");
        const session = state.sessions.get("s1");
        assert.equal(session.updatedAt, before.updatedAt);
        assert.equal(session.state, before.state);
        assert.equal(session.event, before.event);
        assert.equal(session.sessionTitleFromPrompt, false);
        assert.equal(state.buildSessionSnapshot().sessions.find((s) => s.rawSessionId === "s1").sessionTitle, "Renamed while idle");
        enabled = false;
        await nextTurn();
        runtime.clearSessionsByAgent("workbuddy");
        assert.equal(state.sessions.size, 0);
      } finally { runtime.cleanup(); state.cleanup(); }
    });
  });

  it("does not observe remote, WSL, disabled, ended, or foreign-agent sessions", () => {
    const tracks = [];
    const clears = [];
    const sessions = new Map();
    let enabled = true;
    const runtime = createAgentRuntimeMain({ getStateRuntime: () => ({ sessions }), isAgentEnabled: () => enabled,
      updateSession: (id, state, event, opts) => sessions.set(id, { ...opts }),
      workBuddySessionTitleTracker: { track: (...args) => tracks.push(args), clear: (...args) => clears.push(args) } });
    try {
      for (const opts of [{ profileId: "remote" }, { host: "remote-host" }, { wslDistro: "Ubuntu" }, { headless: true }]) {
        runtime.updateSessionFromServer("s1", "working", "PreToolUse", { agentId: "workbuddy", ...opts });
      }
      enabled = false;
      runtime.updateSessionFromServer("s1", "working", "PreToolUse", { agentId: "workbuddy" });
      enabled = true;
      runtime.updateSessionFromServer("s1", "idle", "SessionEnd", { agentId: "workbuddy" });
      runtime.updateSessionFromServer("s1", "working", "PreToolUse", { agentId: "other" });
      assert.deepEqual(tracks, []);
      assert.deepEqual(clears, [["s1"]]);
    } finally { runtime.cleanup(); }
  });
});
