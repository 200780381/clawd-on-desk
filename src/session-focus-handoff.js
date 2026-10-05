"use strict";

const path = require("node:path");
const { spawn } = require("node:child_process");
const { discoverDshDesktopSync } = require("../hooks/dsh-install");

const DSH_DESKTOP_EXE_NAME = "DeepSeek Harness.exe";

function sanitizeFocusError(err) {
  return err && err.message ? err.message.replace(/[\r\n\t]+/g, " ") : "unknown";
}

// Electron exports ELECTRON_RUN_AS_NODE and friends that would make the app
// boot as a Node process instead of a GUI. A GUI launch needs a clean
// environment; for the Windows executable form the keys are case-insensitive.
function stripElectronLaunchEnv(sourceEnv) {
  const env = {};
  const source = sourceEnv && typeof sourceEnv === "object" ? sourceEnv : {};
  for (const key of Object.keys(source)) {
    if (key.toUpperCase().startsWith("ELECTRON_") || key.toUpperCase() === "NODE_OPTIONS") continue;
    env[key] = source[key];
  }
  return env;
}

// Launch the verified desktop app as a GUI. This is intentionally not the
// installer's desktopCommandInfo: that describes the bundled CLI (Node mode
// with a cli.js prefix), which would never restore the app window. The macOS
// `open` and the Windows executable both fall through the app's single-instance
// callback, so an already-running instance is brought to the front.
function launchDshDesktopApp({
  discoverDesktop = discoverDshDesktopSync,
  osPlatform = process.platform,
  spawnImpl = spawn,
  env = process.env,
  pathImpl = path,
} = {}) {
  if (osPlatform !== "darwin" && osPlatform !== "win32") {
    return { launched: false, reason: "desktop-not-found" };
  }
  let discovery;
  try {
    discovery = discoverDesktop({ platform: osPlatform });
  } catch {
    return { launched: false, reason: "desktop-not-found" };
  }
  if (!discovery || discovery.status !== "found" || !discovery.appRoot) {
    return {
      launched: false,
      reason: discovery && discovery.status === "ambiguous" ? "desktop-ambiguous" : "desktop-not-found",
    };
  }
  let command;
  let args;
  if (osPlatform === "darwin") {
    command = "/usr/bin/open";
    args = [discovery.appRoot];
  } else {
    command = pathImpl.win32.join(discovery.appRoot, DSH_DESKTOP_EXE_NAME);
    args = [];
  }
  try {
    const child = spawnImpl(command, args, {
      detached: true,
      stdio: "ignore",
      env: stripElectronLaunchEnv(env),
    });
    if (child && typeof child.unref === "function") child.unref();
  } catch {
    return { launched: false, reason: "launch-failed" };
  }
  return { launched: true, reason: "launched" };
}

function focusDshDesktopTarget({
  shell,
  focusEntry,
  sessionId,
  requestSource = "dashboard",
  url,
  focusLog = () => {},
  discoverDesktop,
  osPlatform,
  spawnImpl,
  env,
  pathImpl,
} = {}) {
  if (!url || !shell || typeof shell.openExternal !== "function") return null;
  const id = String(sessionId || (focusEntry && focusEntry.id) || "");
  focusLog(`focus request source=${requestSource} sid=${id} agent=${(focusEntry && focusEntry.agentId) || "-"} target=dsh-desktop`);
  return Promise.resolve()
    .then(() => shell.openExternal(url))
    .then(() => {
      focusLog(`focus result branch=dsh-desktop reason=opened source=${requestSource} sid=${id}`);
    })
    .catch((err) => {
      focusLog(`focus result branch=dsh-desktop reason=open-failed source=${requestSource} sid=${id} error=${sanitizeFocusError(err)}`);
      const result = launchDshDesktopApp({ discoverDesktop, osPlatform, spawnImpl, env, pathImpl });
      focusLog(`focus result branch=dsh-desktop reason=${result.reason} source=${requestSource} sid=${id}`);
    });
}

function focusCodexThreadTarget({
  shell,
  focusEntry,
  sessionId,
  requestSource = "dashboard",
  url,
  focusLog = () => {},
  focusTerminalSession = () => false,
}) {
  if (!url || !shell || typeof shell.openExternal !== "function") return null;
  const id = String(sessionId || (focusEntry && focusEntry.id) || "");
  focusLog(`focus request source=${requestSource} sid=${id} agent=${(focusEntry && focusEntry.agentId) || "-"} target=codex-thread`);
  return Promise.resolve()
    .then(() => shell.openExternal(url))
    .then(() => {
      focusLog(`focus result branch=codex-thread reason=opened source=${requestSource} sid=${id}`);
    })
    .catch((err) => {
      focusLog(`focus result branch=codex-thread reason=open-failed source=${requestSource} sid=${id} error=${sanitizeFocusError(err)}`);
      return Promise.resolve()
        .then(() => focusTerminalSession(focusEntry, id, requestSource))
        .then((focused) => {
          if (!focused) {
            focusLog(`focus result branch=none reason=codex-thread-fallback-no-source-pid source=${requestSource} sid=${id}`);
          }
        })
        .catch((fallbackErr) => {
          focusLog(`focus result branch=none reason=codex-thread-fallback-failed source=${requestSource} sid=${id} error=${sanitizeFocusError(fallbackErr)}`);
        });
    });
}

module.exports = {
  focusCodexThreadTarget,
  focusDshDesktopTarget,
  launchDshDesktopApp,
  sanitizeFocusError,
  stripElectronLaunchEnv,
};
