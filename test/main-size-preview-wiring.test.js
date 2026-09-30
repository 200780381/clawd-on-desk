"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { it } = require("node:test");

const source = fs.readFileSync(path.join(__dirname, "..", "src", "main.js"), "utf8");

function section(start, end) {
  const from = source.indexOf(start);
  const to = source.indexOf(end, from + start.length);
  assert.ok(from >= 0 && to > from, `missing section: ${start}`);
  return source.slice(from, to);
}

it("wires menu resize and roaming to the shared size preview state", () => {
  const menu = section("const _menuCtx = {", 'const _menu = require("./menu")');
  const roam = section("const _roamCtx = {", 'const _roam = require("./roam")');
  assert.ok(menu.includes("cancelRoam: () => _roam.cancelRoam(),"));
  assert.ok(menu.includes("resetKeepSizeFrozen: () => resetKeepSizeFrozen(),"));
  assert.ok(roam.includes("isSizePreviewActive: () => petWindowRuntime.isSettingsSizePreviewActive(),"));
});

it("cleans up the size preview when the Settings renderer is reset", () => {
  const settings = section(
    "const settingsWindowRuntime = createSettingsWindowRuntime({",
    "  onBeforeClosed: () => {"
  );
  assert.ok(settings.includes(
    "onRendererReset: () => { void settingsSizePreviewSession.cleanup(); },"
  ));
});
