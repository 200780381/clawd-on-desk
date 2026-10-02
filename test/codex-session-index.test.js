"use strict";

const { describe, it, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { readCodexThreadName, readCodexThreadNames } = require("../hooks/codex-session-index");

describe("Codex session index titles", () => {
  let dir;
  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-titles-")); });
  afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

  it("reads each requested session's latest nonempty name, ignoring malformed and unrelated records", () => {
    const records = [
      { id: "one", thread_name: "Old" }, { id: "two", thread_name: "Second" },
      { id: "one", thread_name: "  Renamed  " }, { id: "one", thread_name: " " },
      { id: "foreign", thread_name: "Excluded" },
    ];
    fs.writeFileSync(path.join(dir, "session_index.jsonl"), "broken partial record\n" + records.map(JSON.stringify).join("\n") + '\n{"id":"one",');
    assert.deepStrictEqual(readCodexThreadNames(["codex:one", "two", "missing", null], { codexDir: dir }), new Map([["one", "Renamed"], ["two", "Second"]]));
    assert.strictEqual(readCodexThreadName("codex:one", { codexDir: dir }), "Renamed");
    assert.strictEqual(readCodexThreadName("missing", { codexDir: dir }), null);
  });

  it("respects the bounded tail read", () => {
    const last = JSON.stringify({ id: "recent", thread_name: "Newest" }) + "\n";
    fs.writeFileSync(path.join(dir, "session_index.jsonl"), JSON.stringify({ id: "old", thread_name: "Outside tail" }) + "\n" + last);
    assert.deepStrictEqual(readCodexThreadNames(["old", "recent"], { codexDir: dir, maxBytes: Buffer.byteLength(last) }), new Map([["recent", "Newest"]]));
  });

  it("returns no title when the index is missing or corrupt", () => {
    assert.deepStrictEqual(readCodexThreadNames(["one"], { codexDir: dir }), new Map());
    fs.writeFileSync(path.join(dir, "session_index.jsonl"), "{broken");
    assert.strictEqual(readCodexThreadName("one", { codexDir: dir }), null);
  });
});
