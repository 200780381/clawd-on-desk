"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const { describeLongFreeze } = require("../scripts/manual/mobile-freeze-e2e");

test("freeze classification uses the page's post-thaw 1006", () => {
  const closes = [{ code: 1000, at: 50 }, { code: 1006, at: 200 }];
  assert.match(describeLongFreeze(false, closes, 100), /disconnect recovery/);
  assert.match(describeLongFreeze(true, closes, 100), /not #663/);
});

test("default Chrome case fails without an observed post-thaw disconnect", () => {
  for (const closes of [[], [{ code: 1006, at: 50 }], [{ code: 1000, at: 200 }]]) {
    assert.throws(() => describeLongFreeze(false, closes, 100), /must expose a thaw disconnect/);
  }
  assert.equal(describeLongFreeze(true, [], 100), "preserved socket");
});
