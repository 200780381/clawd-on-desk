// test/linux-x11-cursor.test.js — Unit tests for src/linux-x11-cursor.js
const { describe, it } = require("node:test");
const assert = require("node:assert");

const {
  shouldUseX11CursorQuery,
  installLinuxX11CursorFallback,
} = require("../src/linux-x11-cursor");

const use = (platform, env, argv = ["electron", "."]) =>
  shouldUseX11CursorQuery({ platform, env, argv });

describe("shouldUseX11CursorQuery()", () => {
  it("is false off Linux", () => {
    assert.strictEqual(use("darwin", { DISPLAY: ":0" }), false);
    assert.strictEqual(use("win32", { DISPLAY: ":0" }), false);
  });

  it("is false without DISPLAY", () => {
    assert.strictEqual(use("linux", { XDG_SESSION_TYPE: "x11" }), false);
  });

  it("is true on an X11 session", () => {
    assert.strictEqual(use("linux", { XDG_SESSION_TYPE: "x11", DISPLAY: ":0" }), true);
  });

  it("is false on a Wayland session running the native Wayland backend", () => {
    assert.strictEqual(use("linux", { XDG_SESSION_TYPE: "wayland", DISPLAY: ":0" }), false);
    assert.strictEqual(use("linux", { WAYLAND_DISPLAY: "wayland-0", DISPLAY: ":0" }), false);
  });

  it("follows an explicit --ozone-platform on argv", () => {
    const wayland = { XDG_SESSION_TYPE: "wayland", DISPLAY: ":0" };
    assert.strictEqual(use("linux", wayland, ["electron", ".", "--ozone-platform=x11"]), true);
    const x11 = { XDG_SESSION_TYPE: "x11", DISPLAY: ":0" };
    assert.strictEqual(use("linux", x11, ["electron", ".", "--ozone-platform=wayland"]), false);
  });
});

describe("installLinuxX11CursorFallback()", () => {
  const x11 = { platform: "linux", env: { XDG_SESSION_TYPE: "x11", DISPLAY: ":0" }, argv: ["electron"] };

  function makeScreen(extra = {}) {
    return { getCursorScreenPoint: () => ({ x: 1, y: 2 }), ...extra };
  }

  it("does not touch screen when not applicable", () => {
    const screen = makeScreen();
    const orig = screen.getCursorScreenPoint;
    assert.strictEqual(installLinuxX11CursorFallback(screen, { ...x11, platform: "darwin" }), false);
    assert.strictEqual(screen.getCursorScreenPoint, orig);
  });

  it("returns the live X11 point converted to DIP", () => {
    const screen = makeScreen({ screenToDipPoint: (p) => ({ x: p.x / 2, y: p.y / 2 }) });
    assert.strictEqual(
      installLinuxX11CursorFallback(screen, { ...x11, queryPointer: () => ({ x: 3001, y: 400 }) }),
      true
    );
    assert.deepStrictEqual(screen.getCursorScreenPoint(), { x: 1501, y: 200 });
  });

  it("returns the physical point when screenToDipPoint is missing", () => {
    const screen = makeScreen();
    installLinuxX11CursorFallback(screen, { ...x11, queryPointer: () => ({ x: 3000, y: 400 }) });
    assert.deepStrictEqual(screen.getCursorScreenPoint(), { x: 3000, y: 400 });
  });

  it("falls back to Electron's value when the X11 query fails", () => {
    const screen = makeScreen();
    installLinuxX11CursorFallback(screen, { ...x11, queryPointer: () => null });
    assert.deepStrictEqual(screen.getCursorScreenPoint(), { x: 1, y: 2 });
  });
});
