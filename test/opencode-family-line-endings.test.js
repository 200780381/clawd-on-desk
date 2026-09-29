"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

test("PR #1053 follow-up: opencode family source uses only LF line endings", () => {
  const bytes = fs.readFileSync(path.join(__dirname, "..", "agents", "opencode-family.js"));
  assert.strictEqual(bytes.includes(0x0d), false);
});
