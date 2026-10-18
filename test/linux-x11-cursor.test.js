"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const {
  loadXcbPointerBindings,
  createX11PointerQuery,
  installLinuxX11CursorFallback,
} = require("../src/linux-x11-cursor");

function makeScreen(extra = {}) {
  return {
    getCursorScreenPoint: () => ({ x: 1, y: 2 }),
    screenToDipPoint: (p) => ({ x: p.x, y: p.y }),
    ...extra,
  };
}

describe("installLinuxX11CursorFallback()", () => {
  it("leaves screen untouched off the X11 backend", () => {
    const screen = makeScreen();
    const original = screen.getCursorScreenPoint;
    assert.equal(installLinuxX11CursorFallback(screen, { isLinuxX11: false, queryPointer: () => ({ x: 9, y: 9 }) }), false);
    assert.equal(screen.getCursorScreenPoint, original);
  });

  it("leaves screen untouched without screenToDipPoint", () => {
    const screen = makeScreen({ screenToDipPoint: undefined });
    const original = screen.getCursorScreenPoint;
    assert.equal(installLinuxX11CursorFallback(screen, { isLinuxX11: true, queryPointer: () => ({ x: 9, y: 9 }) }), false);
    assert.equal(screen.getCursorScreenPoint, original);
  });

  it("returns the live X11 point converted to DIP", () => {
    const screen = makeScreen({ screenToDipPoint: (p) => ({ x: p.x / 2, y: p.y / 2 }) });
    assert.equal(
      installLinuxX11CursorFallback(screen, { isLinuxX11: true, queryPointer: () => ({ x: 3001, y: 400 }) }),
      true,
    );
    assert.deepEqual(screen.getCursorScreenPoint(), { x: 1500, y: 200 });
  });

  it("keeps the last physical pixel inside the display at scale 2", () => {
    const screen = makeScreen({ screenToDipPoint: (p) => ({ x: p.x / 2, y: p.y / 2 }) });
    installLinuxX11CursorFallback(screen, { isLinuxX11: true, queryPointer: () => ({ x: 1919, y: 1079 }) });
    assert.deepEqual(screen.getCursorScreenPoint(), { x: 959, y: 539 });
  });

  it("falls back to Electron's value when the X11 query fails", () => {
    const screen = makeScreen();
    installLinuxX11CursorFallback(screen, { isLinuxX11: true, queryPointer: () => null });
    assert.deepEqual(screen.getCursorScreenPoint(), { x: 1, y: 2 });
  });

  it("falls back to Electron's value when screenToDipPoint throws", () => {
    const screen = makeScreen({ screenToDipPoint: () => { throw new Error("no display"); } });
    installLinuxX11CursorFallback(screen, { isLinuxX11: true, queryPointer: () => ({ x: 3000, y: 400 }) });
    assert.deepEqual(screen.getCursorScreenPoint(), { x: 1, y: 2 });
  });
});

function makeBindings({ connectionError = 0, root = 0x3c3, pointers = [] } = {}) {
  const calls = [];
  const connection = { id: "conn" };
  let errorAfterQuery = 0;
  const bindings = {
    calls,
    connection,
    loseConnection(code = 1) { errorAfterQuery = code; },
    connect: (displayName) => {
      calls.push(["connect", displayName]);
      return { connection, screen: 0 };
    },
    hasError: () => {
      calls.push(["hasError"]);
      return connectionError || errorAfterQuery;
    },
    rootWindow: (conn, screen) => {
      calls.push(["rootWindow", conn === connection, screen]);
      return root;
    },
    queryPointer: (conn, window) => {
      calls.push(["queryPointer", conn === connection, window]);
      if (errorAfterQuery) return null;
      return pointers.length ? pointers.shift() : { sameScreen: true, x: 10, y: 20 };
    },
    disconnect: (conn) => calls.push(["disconnect", conn === connection]),
  };
  return bindings;
}

const callNames = (bindings) => bindings.calls.map((call) => call[0]);

describe("createX11PointerQuery()", () => {
  it("connects lazily once to the given display and returns root coordinates", () => {
    const bindings = makeBindings();
    const query = createX11PointerQuery({ bindings, displayName: ":1" });
    assert.deepEqual(bindings.calls, []);
    assert.deepEqual(query(), { x: 10, y: 20 });
    assert.deepEqual(query(), { x: 10, y: 20 });
    assert.deepEqual(callNames(bindings), ["connect", "hasError", "rootWindow", "queryPointer", "queryPointer"]);
    assert.deepEqual(bindings.calls[0], ["connect", ":1"]);
    assert.deepEqual(bindings.calls[3], ["queryPointer", true, 0x3c3]);
  });

  it("uses the default display when none is given", () => {
    const bindings = makeBindings();
    createX11PointerQuery({ bindings, displayName: "" })();
    assert.deepEqual(bindings.calls[0], ["connect", null]);
  });

  it("returns null while the pointer is on another X screen, and keeps the connection", () => {
    const bindings = makeBindings({ pointers: [{ sameScreen: false, x: 0, y: 0 }] });
    const query = createX11PointerQuery({ bindings });
    assert.equal(query(), null);
    assert.deepEqual(query(), { x: 10, y: 20 });
    assert.ok(!callNames(bindings).includes("disconnect"));
  });

  it("reports a failed connection once, disconnects it and does not retry", () => {
    const errors = [];
    const bindings = makeBindings({ connectionError: 1 });
    const query = createX11PointerQuery({ bindings, onError: (err) => errors.push(err.message) });
    assert.equal(query(), null);
    assert.equal(query(), null);
    assert.deepEqual(callNames(bindings), ["connect", "hasError", "disconnect"]);
    assert.deepEqual(errors, ["X11 connection failed (xcb_connection_has_error 1)"]);
  });

  it("disconnects when the root window cannot be found", () => {
    const errors = [];
    const bindings = makeBindings({ root: null });
    const query = createX11PointerQuery({ bindings, onError: (err) => errors.push(err.message) });
    assert.equal(query(), null);
    assert.deepEqual(callNames(bindings), ["connect", "hasError", "rootWindow", "disconnect"]);
    assert.equal(errors.length, 1);
  });

  it("shuts down after the connection is lost", () => {
    const errors = [];
    const bindings = makeBindings();
    const query = createX11PointerQuery({ bindings, onError: (err) => errors.push(err.message) });
    assert.deepEqual(query(), { x: 10, y: 20 });
    bindings.loseConnection(2);
    assert.equal(query(), null);
    assert.equal(query(), null);
    assert.equal(callNames(bindings).filter((name) => name === "queryPointer").length, 2);
    assert.equal(callNames(bindings).at(-1), "disconnect");
    assert.deepEqual(errors, ["X11 connection lost (xcb_connection_has_error 2)"]);
  });

  it("shuts down when a binding throws", () => {
    const errors = [];
    const bindings = makeBindings();
    bindings.queryPointer = () => { throw new Error("boom"); };
    const query = createX11PointerQuery({ bindings, onError: (err) => errors.push(err.message) });
    assert.equal(query(), null);
    assert.equal(query(), null);
    assert.deepEqual(errors, ["boom"]);
    assert.equal(callNames(bindings).at(-1), "disconnect");
  });

  it("swallows errors thrown by onError", () => {
    const bindings = makeBindings({ connectionError: 1 });
    const query = createX11PointerQuery({ bindings, onError: () => { throw new Error("log failed"); } });
    assert.equal(query(), null);
  });
});

describe("loadXcbPointerBindings()", () => {
  let koffi = null;
  let koffiLoadError = null;
  let libxcbLoadable = false;
  if (process.platform === "linux") {
    try {
      koffi = require("koffi");
    } catch (error) {
      koffiLoadError = error;
    }
    if (koffi) {
      try {
        koffi.load("libxcb.so.1");
        libxcbLoadable = true;
      } catch {}
    }
  }
  const realBindingSkip = process.platform !== "linux"
    ? "Linux only"
    : (!koffiLoadError && !libxcbLoadable && "needs libxcb.so.1");

  it("reports an unreachable display through the real libxcb bindings", { skip: realBindingSkip }, () => {
    if (koffiLoadError) throw koffiLoadError;
    const errors = [];
    const query = createX11PointerQuery({
      bindings: loadXcbPointerBindings(koffi),
      displayName: ":65535",
      onError: (err) => errors.push(err.message),
    });
    assert.equal(query(), null);
    assert.equal(errors.length, 1);
    assert.match(errors[0], /xcb_connection_has_error/);
  });

  const liveSkip = realBindingSkip || (!process.env.DISPLAY && "needs an X display");
  it("queries the live pointer through the real libxcb bindings", { skip: liveSkip }, () => {
    if (koffiLoadError) throw koffiLoadError;
    const errors = [];
    const query = createX11PointerQuery({
      bindings: loadXcbPointerBindings(koffi),
      onError: (err) => errors.push(err.message),
    });
    const point = query();
    assert.deepEqual(errors, []);
    assert.ok(point, "pointer should be on the default screen");
    assert.ok(Number.isInteger(point.x) && Number.isInteger(point.y));
  });
});

describe("main.js wiring", () => {
  it("installs after ready with the same X11 backend check as linux-x11-input-hint", () => {
    const mainSource = fs.readFileSync(path.join(__dirname, "..", "src", "main.js"), "utf8");
    const ready = mainSource.indexOf("app.whenReady().then(async () => {");
    const install = mainSource.indexOf("installLinuxX11CursorFallback(screen, {");
    assert.ok(ready >= 0 && install > ready, "install must run inside app.whenReady()");
    assert.match(
      mainSource.slice(install),
      /^installLinuxX11CursorFallback\(screen, \{\s*isLinuxX11:\s*isLinux && app\.commandLine\.getSwitchValue\("ozone-platform"\) === "x11",\s*displayName:\s*app\.commandLine\.getSwitchValue\("display"\),\s*onError:/,
    );
  });
});
