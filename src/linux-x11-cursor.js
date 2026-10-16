"use strict";

// ── Linux / X11: live global cursor position ──
//
// Under the X11 Ozone backend, Electron's screen.getCursorScreenPoint() returns
// the root location of the last pointer event Chromium itself received, not a
// fresh XQueryPointer. Once the cursor leaves our own windows the value
// freezes at the last point seen, so idle eye tracking looks at a stale spot
// (measured on Electron 41 / Xorg: ~80% of samples wrong while the cursor
// roamed a dual-head desktop, correct only near the pet window).
//
// Fix: on an X11 backend, ask the X server directly via libX11 XQueryPointer
// (through koffi, which already ships Linux binaries) and convert the
// physical root coordinates to DIP. Any failure — no libX11, no display,
// pointer on another X screen — falls back to Electron's own value.

const { parseOzonePlatformFromArgv } = require("./linux-ozone");

// Whether this process runs Chromium's X11 Ozone backend with a reachable
// DISPLAY. Pure for tests.
function shouldUseX11CursorQuery(options = {}) {
  const platform = options.platform || process.platform;
  if (platform !== "linux") return false;
  const env = options.env || process.env;
  if (!String(env.DISPLAY || "").trim()) return false;
  const argvOzone = String(parseOzonePlatformFromArgv(options.argv || process.argv) || "").trim().toLowerCase();
  if (argvOzone) return argvOzone === "x11";
  // No explicit flag: Chromium's auto hint picks Wayland on a Wayland session.
  const sessionType = String(env.XDG_SESSION_TYPE || "").trim().toLowerCase();
  const underWayland = sessionType === "wayland" || !!String(env.WAYLAND_DISPLAY || "").trim();
  return !underWayland;
}

function createX11PointerQuery(loadKoffi = () => require("koffi")) {
  let state = null; // null = not tried, false = unavailable

  function init() {
    const koffi = loadKoffi();
    const lib = koffi.load("libX11.so.6");
    const XOpenDisplay = lib.func("void *XOpenDisplay(const char *name)");
    const XDefaultRootWindow = lib.func("unsigned long XDefaultRootWindow(void *display)");
    const XQueryPointer = lib.func(
      "int XQueryPointer(void *display, unsigned long w, _Out_ unsigned long *root_return, "
      + "_Out_ unsigned long *child_return, _Out_ int *root_x, _Out_ int *root_y, "
      + "_Out_ int *win_x, _Out_ int *win_y, _Out_ unsigned int *mask)"
    );
    const display = XOpenDisplay(null);
    if (!display) throw new Error("XOpenDisplay failed");
    return { XQueryPointer, display, root: XDefaultRootWindow(display) };
  }

  return function queryPointer() {
    if (state === false) return null;
    if (state === null) {
      try {
        state = init();
      } catch (err) {
        state = false;
        console.warn("Clawd: X11 cursor query unavailable, using Electron cursor point:", err && err.message ? err.message : err);
        return null;
      }
    }
    const rootRet = [0], childRet = [0], rx = [0], ry = [0], wx = [0], wy = [0], mask = [0];
    let sameScreen = 0;
    try {
      sameScreen = state.XQueryPointer(state.display, state.root, rootRet, childRet, rx, ry, wx, wy, mask);
    } catch {
      return null;
    }
    if (!sameScreen) return null;
    return { x: rx[0], y: ry[0] };
  };
}

// Replace screen.getCursorScreenPoint with a live X11 query when appropriate.
// Returns true if installed.
function installLinuxX11CursorFallback(screen, options = {}) {
  if (!screen || typeof screen.getCursorScreenPoint !== "function") return false;
  if (!shouldUseX11CursorQuery(options)) return false;
  const query = options.queryPointer || createX11PointerQuery();
  const original = screen.getCursorScreenPoint.bind(screen);
  screen.getCursorScreenPoint = function getCursorScreenPoint() {
    const physical = query();
    if (!physical) return original();
    if (typeof screen.screenToDipPoint === "function") {
      try {
        const dip = screen.screenToDipPoint(physical);
        return { x: Math.round(dip.x), y: Math.round(dip.y) };
      } catch {}
    }
    return physical;
  };
  return true;
}

module.exports = {
  shouldUseX11CursorQuery,
  createX11PointerQuery,
  installLinuxX11CursorFallback,
};
