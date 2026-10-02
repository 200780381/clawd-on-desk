"use strict";

const { describe, it, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const {
  encodeClaudeProjectDir,
  getClaudeProjectsDir,
  probeTranscript,
  loadResumableSessionHistory,
  resolveResumeTarget,
  clearTitleExtractionCache,
} = require("../src/session-history-loader");
const {
  LEGACY_HISTORY_VERSION,
  HISTORY_FILE_PREFIX,
  getHistoryFilePath,
  recordSessionHistoryFromStateBody,
} = require("../hooks/session-history");

describe("session history loader", () => {
  let root;
  let historyDir;
  let claudeProjectsDir;
  let projectCwd;
  const T0 = 1_700_000_000_000;
  const BOOT_A = T0 - 3_600_000;
  const BOOT_B = T0 + 600_000;

  beforeEach(() => {
    clearTitleExtractionCache();
    root = fs.mkdtempSync(path.join(os.tmpdir(), "clawd-history-loader-"));
    historyDir = path.join(root, "history");
    claudeProjectsDir = path.join(root, "claude-projects");
    projectCwd = path.join(root, "project");
    fs.mkdirSync(historyDir, { recursive: true });
    fs.mkdirSync(claudeProjectsDir, { recursive: true });
    fs.mkdirSync(projectCwd, { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  function record(sessionId, eventAt, boot = BOOT_A, overrides = {}, historyOptions = {}) {
    return recordSessionHistoryFromStateBody({
      agent_id: "claude-code",
      session_id: sessionId,
      event: "UserPromptSubmit",
      state: "working",
      agent_pid: process.pid,
      source_pid: process.pid,
      cwd: projectCwd,
      session_title: `Session ${sessionId}`,
      ...overrides,
    }, { historyDir, eventAt, uptime: () => (eventAt - boot) / 1000, ...historyOptions });
  }

  function writeTranscript(sessionId, cwd = projectCwd) {
    const dir = path.join(claudeProjectsDir, encodeClaudeProjectDir(cwd));
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, `${sessionId}.jsonl`), '{"type":"user"}\n');
  }

  // A transcript whose lines the test controls, for title extraction cases.
  function writeTranscriptLines(sessionId, entries, cwd = projectCwd) {
    const dir = path.join(claudeProjectsDir, encodeClaudeProjectDir(cwd));
    fs.mkdirSync(dir, { recursive: true });
    const body = entries
      .map((entry) => (typeof entry === "string" ? entry : JSON.stringify(entry)))
      .join("\n");
    fs.writeFileSync(path.join(dir, `${sessionId}.jsonl`), body ? `${body}\n` : "");
  }

  function loadOpts(extra = {}) {
    return {
      historyDir,
      claudeProjectsDir,
      now: BOOT_B + 60_000,
      uptime: () => 60,
      ...extra,
    };
  }

  describe("project directory encoding", () => {
    it("maps every character outside [A-Za-z0-9-] to a dash", () => {
      assert.equal(
        encodeClaudeProjectDir("/Users/me/Workspace/Work"),
        "-Users-me-Workspace-Work",
      );
      // Two CJK characters collapse to two dashes, matching Claude Code.
      assert.equal(
        encodeClaudeProjectDir("/Users/me/Workspace/在场"),
        "-Users-me-Workspace---",
      );
      assert.equal(encodeClaudeProjectDir("/a.b/c_d"), "-a-b-c-d");
      assert.equal(encodeClaudeProjectDir(""), null);
    });
  });

  describe("transcript probing", () => {
    it("honours the configured Claude home without probing the default account", () => {
      const previous = process.env.CLAUDE_CONFIG_DIR;
      try {
        process.env.CLAUDE_CONFIG_DIR = path.join(root, "custom-claude");
        assert.equal(
          getClaudeProjectsDir({ kind: "default", configDir: null }),
          path.join(os.homedir(), ".claude", "projects"),
        );
        assert.equal(
          getClaudeProjectsDir({ kind: "default", configDir: null }, loadOpts()),
          claudeProjectsDir,
        );
        assert.equal(
          getClaudeProjectsDir({ kind: "custom", configDir: path.join(root, "recorded-claude") }),
          path.join(root, "recorded-claude", "projects"),
        );
      } finally {
        if (previous === undefined) delete process.env.CLAUDE_CONFIG_DIR;
        else process.env.CLAUDE_CONFIG_DIR = previous;
      }
    });

    it("rejects path-bearing IDs before any transcript filesystem access", (t) => {
      const reads = t.mock.method(fs, "lstatSync", () => { throw new Error("must not read"); });
      for (const id of ["../secret", "x/y", "x\\y", "", "   ", "a\n"]) {
        assert.equal(probeTranscript(
          "claude-code", id, projectCwd, { kind: "default", configDir: null }, loadOpts(),
        ), null);
      }
      assert.equal(reads.mock.callCount(), 0);
    });

    it("treats access and I/O errors as unknown, not missing", (t) => {
      writeTranscript("has-transcript");
      const lstat = fs.lstatSync;
      t.mock.method(fs, "lstatSync", (file, ...args) => {
        if (String(file).endsWith("has-transcript.jsonl")) {
          throw Object.assign(new Error("unreadable"), { code: "EACCES" });
        }
        return lstat(file, ...args);
      });
      assert.equal(probeTranscript(
        "claude-code", "has-transcript", projectCwd, { kind: "default", configDir: null }, loadOpts(),
      ), null);
    });

    it("reports present, confidently missing, and unknown distinctly", () => {
      writeTranscript("has-transcript");

      assert.equal(
        probeTranscript("claude-code", "has-transcript", projectCwd,
          { kind: "default", configDir: null }, loadOpts()),
        true,
      );
      // Project dir exists, this transcript does not -> a confident no.
      assert.equal(
        probeTranscript("claude-code", "no-transcript", projectCwd,
          { kind: "default", configDir: null }, loadOpts()),
        false,
      );
      // No project dir at all -> unknown, never a claim.
      assert.equal(
        probeTranscript("claude-code", "anything", path.join(root, "elsewhere"),
          { kind: "default", configDir: null }, loadOpts()),
        null,
      );
      // Another agent's layout is not ours to interpret.
      assert.equal(probeTranscript(
        "codex", "x", projectCwd, { kind: "default", configDir: null }, loadOpts(),
      ), null);
    });
  });

  describe("resume list", () => {
    it("probes each row against its recorded profile without exposing the profile path", () => {
      const customConfigDir = path.join(root, "custom-claude");
      const defaultRecord = record("shared-id", T0, BOOT_A, {}, { env: {} });
      const customRecord = record("shared-id", T0 + 1, BOOT_A, {}, {
        env: { CLAUDE_CONFIG_DIR: customConfigDir },
      });
      writeTranscript("shared-id");
      fs.mkdirSync(path.join(customConfigDir, "projects", encodeClaudeProjectDir(projectCwd)), {
        recursive: true,
      });

      const previous = process.env.CLAUDE_CONFIG_DIR;
      process.env.CLAUDE_CONFIG_DIR = path.join(root, "wrong-main-profile");
      try {
        const rows = loadResumableSessionHistory(loadOpts());
        assert.equal(rows.length, 2);
        const defaultRow = rows.find((row) => row.historyKey === defaultRecord.record.historyKey);
        const customRow = rows.find((row) => row.historyKey === customRecord.record.historyKey);
        assert.equal(defaultRow.transcriptPresent, true);
        assert.equal(customRow.transcriptPresent, false);
        assert.notEqual(defaultRow.historyKey, customRow.historyKey);
        assert.equal(Object.prototype.hasOwnProperty.call(defaultRow, "profile"), false);
        assert.equal(JSON.stringify(rows).includes(customConfigDir), false);
      } finally {
        if (previous === undefined) delete process.env.CLAUDE_CONFIG_DIR;
        else process.env.CLAUDE_CONFIG_DIR = previous;
      }
    });

    it("keeps legacy rows visible but disables resume when profile provenance is absent", () => {
      const legacy = {
        version: LEGACY_HISTORY_VERSION,
        agentId: "claude-code",
        sessionId: "legacy-session",
        cwd: projectCwd,
        title: "Legacy",
        lastState: "working",
        firstSeenAt: T0,
        lastEventAt: T0,
        endedAt: null,
        bootApproxAt: BOOT_A,
      };
      // Reproduce the v1 filename directly. Calling the current path helper
      // alone would let a migration bug change both production and fixture.
      const legacyHash = crypto.createHash("sha256")
        .update(`claude-code\0${legacy.sessionId}`)
        .digest("hex")
        .slice(0, 32);
      const legacyPath = path.join(historyDir, `${HISTORY_FILE_PREFIX}${legacyHash}.json`);
      assert.equal(getHistoryFilePath("claude-code", legacy.sessionId, {
        historyDir,
        version: LEGACY_HISTORY_VERSION,
      }), legacyPath);
      fs.writeFileSync(legacyPath, JSON.stringify(legacy));

      const [row] = loadResumableSessionHistory(loadOpts());
      assert.equal(row.sessionId, "legacy-session");
      assert.equal(row.resumeDisabledReason, "profile-unverified");
      assert.equal(row.transcriptPresent, null);
      assert.match(row.historyKey, /^[a-f0-9]{32}$/);
      assert.equal(resolveResumeTarget("claude-code", row.historyKey, loadOpts()), null);
    });

    it("offers interrupted rows first and flags a missing transcript", () => {
      record("interrupted-one", T0);
      record("ended-one", T0 + 1000, BOOT_A, { event: "SessionEnd", state: "idle" });
      writeTranscript("ended-one");

      const rows = loadResumableSessionHistory(loadOpts());
      assert.deepEqual(rows.map((r) => r.sessionId), ["interrupted-one", "ended-one"]);
      assert.equal(rows[0].interrupted, true);
      assert.equal(rows[0].transcriptPresent, false, "no transcript was written for it");
      assert.equal(rows[1].interrupted, false);
      assert.equal(rows[1].transcriptPresent, true);
      assert.equal(rows[0].cwd, projectCwd);
    });

    it("still offers a row whose transcript state is unknown", () => {
      // No project directory at all, so the probe cannot tell.
      record("unknowable", T0);
      const rows = loadResumableSessionHistory(loadOpts());
      assert.equal(rows.length, 1);
      assert.equal(rows[0].transcriptPresent, null);
    });

    it("hides sessions that are already live on screen", () => {
      record("running-now", T0);
      record("finished", T0 + 1000, BOOT_A, { event: "SessionEnd", state: "idle" });

      const rows = loadResumableSessionHistory(loadOpts({
        activeRawSessionIds: new Set(["running-now"]),
      }));
      assert.deepEqual(rows.map((r) => r.sessionId), ["finished"]);
    });

    it("honours the row limit after the active filter", () => {
      for (let i = 0; i < 5; i++) record(`s-${i}`, T0 + i * 1000);
      const rows = loadResumableSessionHistory(loadOpts({
        limit: 2,
        activeRawSessionIds: new Set(["s-4"]),
      }));
      assert.equal(rows.length, 2);
      assert.ok(!rows.some((r) => r.sessionId === "s-4"));
    });

    it("never returns prompts or responses", () => {
      record("s", T0, BOOT_A, { assistant_last_output: "secret", prompt: "secret" });
      const [row] = loadResumableSessionHistory(loadOpts());
      assert.ok(!JSON.stringify(row).includes("secret"));
    });

    it("names a session from its first prompt when no title was recorded", () => {
      record("titled", T0, BOOT_A, { session_title: "" });
      writeTranscriptLines("titled", [
        { type: "last-prompt", leafUuid: "leaf" },
        { type: "attachment", attachment: { path: "notes.txt" } },
        { type: "user", message: { role: "user", content: "Fix the theme loader crash" } },
        { type: "assistant", message: { role: "assistant", content: "On it" } },
      ]);

      const [row] = loadResumableSessionHistory(loadOpts());
      assert.equal(row.title, "Fix the theme loader crash");
    });

    it("skips metadata rows and falls back to the slash command that started the session", () => {
      record("cmd", T0, BOOT_A, { session_title: "" });
      writeTranscriptLines("cmd", [
        { type: "user", isMeta: true, message: { role: "user", content: "meta noise" } },
        { type: "user", message: { role: "user", content: "<command-message>specrune-init</command-message>" } },
        { type: "user", message: { role: "user", content: [{ type: "tool_result", content: "x" }] } },
      ]);

      const [row] = loadResumableSessionHistory(loadOpts());
      assert.equal(row.title, "/specrune-init");
    });

    it("keeps reading when the transcript head is one huge record", () => {
      record("big", T0, BOOT_A, { session_title: "" });
      writeTranscriptLines("big", [
        JSON.stringify({ type: "attachment", data: "x".repeat(20 * 1024) }),
        { type: "user", message: { role: "user", content: "After the big line" } },
      ]);

      const [row] = loadResumableSessionHistory(loadOpts());
      assert.equal(row.title, "After the big line");
    });

    it("never overrides a recorded title, nor names rows it cannot confirm", () => {
      record("named", T0, BOOT_A, { session_title: "Recorded title" });
      writeTranscriptLines("named", [
        { type: "user", message: { role: "user", content: "From transcript" } },
      ]);
      // An empty transcript file probes as false — nothing to name.
      record("gone", T0 + 1000, BOOT_A, { session_title: "" });
      writeTranscriptLines("gone", []);

      const rows = loadResumableSessionHistory(loadOpts());
      const named = rows.find((row) => row.sessionId === "named");
      const gone = rows.find((row) => row.sessionId === "gone");
      assert.equal(named.title, "Recorded title");
      assert.equal(gone.title, null);
    });

    it("gives no title when the opening prompt is secret-shaped, even if a later prompt is plain", () => {
      record("secret", T0, BOOT_A, { session_title: "" });
      writeTranscriptLines("secret", [
        { type: "user", message: { role: "user", content: "deploy with token ghp_abcdefghijklmnopqrstuvwxyz0123456789" } },
        { type: "user", message: { role: "user", content: "a perfectly normal follow-up" } },
      ]);
      // The opening line decides; a secret in it means "no safe name", so the
      // extraction must not fall through to the next prompt.
      const [row] = loadResumableSessionHistory(loadOpts());
      assert.equal(row.title, null);
    });

    it("titles a multi-line prompt from its first line even when a later line holds a key", () => {
      record("multi", T0, BOOT_A, { session_title: "" });
      writeTranscriptLines("multi", [
        { type: "user", message: { role: "user", content: "please deploy this\nAWS key AKIAABCDEFGHIJKLMNOP" } },
      ]);
      const [row] = loadResumableSessionHistory(loadOpts());
      assert.equal(row.title, "please deploy this");
    });

    it("survives null entries and null content parts without dropping any row", () => {
      record("null-part", T0, BOOT_A, { session_title: "" });
      writeTranscriptLines("null-part", [
        "null",
        { type: "user", message: { role: "user", content: [null, { type: "text", text: "kept the list alive" }] } },
      ]);
      record("healthy", T0 + 1000, BOOT_A, { session_title: "" });
      writeTranscriptLines("healthy", [
        { type: "user", message: { role: "user", content: "second row intact" } },
      ]);

      const rows = loadResumableSessionHistory(loadOpts());
      assert.equal(rows.length, 2);
      assert.equal(rows.find((row) => row.sessionId === "null-part").title, "kept the list alive");
      assert.equal(rows.find((row) => row.sessionId === "healthy").title, "second row intact");
    });

    it("names a prompt that merely mentions tool_result", () => {
      record("asks", T0, BOOT_A, { session_title: "" });
      writeTranscriptLines("asks", [
        { type: "user", message: { role: "user", content: "why does tool_result come back empty?" } },
      ]);
      const [row] = loadResumableSessionHistory(loadOpts());
      assert.equal(row.title, "why does tool_result come back empty?");
    });

    it("keeps the slash command found before a record that overruns the 1MiB cap", () => {
      record("big-cmd", T0, BOOT_A, { session_title: "" });
      writeTranscriptLines("big-cmd", [
        { type: "user", message: { role: "user", content: "<command-message>specrune-init</command-message>" } },
        JSON.stringify({ type: "attachment", data: "x".repeat(1100 * 1024) }),
      ]);
      const [row] = loadResumableSessionHistory(loadOpts());
      assert.equal(row.title, "/specrune-init");
    });

    it("extracts once per unchanged transcript and again after it changes", (t) => {
      record("cached", T0, BOOT_A, { session_title: "" });
      writeTranscriptLines("cached", [
        { type: "user", message: { role: "user", content: "Original opening line" } },
      ]);
      record("unnamed", T0 + 1000, BOOT_A, { session_title: "" });
      writeTranscriptLines("unnamed", [
        { type: "user", message: { role: "user", content: [{ type: "tool_result", content: "x" }] } },
      ]);
      const transcriptPath = (id) => path.join(
        claudeProjectsDir, encodeClaudeProjectDir(projectCwd), `${id}.jsonl`,
      );
      const first = loadResumableSessionHistory(loadOpts());
      assert.equal(first.find((row) => row.sessionId === "cached").title, "Original opening line");
      assert.equal(first.find((row) => row.sessionId === "unnamed").title, null);

      // A second load over the same unchanged files — titled or not — must
      // not open a single transcript again.
      const realOpen = fs.openSync;
      let opens = 0;
      t.mock.method(fs, "openSync", (file, ...args) => {
        if (String(file) === transcriptPath("cached") || String(file) === transcriptPath("unnamed")) {
          opens += 1;
        }
        return realOpen(file, ...args);
      });
      const second = loadResumableSessionHistory(loadOpts());
      assert.equal(second.find((row) => row.sessionId === "cached").title, "Original opening line");
      assert.equal(second.find((row) => row.sessionId === "unnamed").title, null);
      assert.equal(opens, 0);

      // The file changed (content and mtime both) — extract again.
      const later = new Date(Date.now() + 10_000);
      fs.utimesSync(transcriptPath("cached"), later, later);
      writeTranscriptLines("cached", [
        { type: "user", message: { role: "user", content: "A different opening line" } },
      ]);
      fs.utimesSync(transcriptPath("cached"), later, later);
      const third = loadResumableSessionHistory(loadOpts());
      assert.equal(third.find((row) => row.sessionId === "cached").title, "A different opening line");
      assert.ok(opens > 0);
    });
  });

  describe("resume target resolution", () => {
    it("reads the working directory from the store, not from the caller", () => {
      const recorded = record("target", T0);
      const resolved = resolveResumeTarget("claude-code", recorded.record.historyKey, loadOpts());
      assert.deepEqual(resolved, {
        agentId: "claude-code",
        sessionId: "target",
        historyKey: recorded.record.historyKey,
        cwd: projectCwd,
        profile: { kind: "default", configDir: null },
      });
    });

    it("refuses unknown rows and vanished folders", () => {
      const recorded = record("target", T0);
      assert.equal(resolveResumeTarget("claude-code", "0".repeat(32), loadOpts()), null);
      assert.equal(resolveResumeTarget("codex", recorded.record.historyKey, loadOpts()), null);
      assert.equal(resolveResumeTarget(null, recorded.record.historyKey, loadOpts()), null);

      fs.rmSync(projectCwd, { recursive: true, force: true });
      assert.equal(
        resolveResumeTarget("claude-code", recorded.record.historyKey, loadOpts()),
        null,
        "a deleted project folder must not be relaunched into",
      );
    });
  });
});
