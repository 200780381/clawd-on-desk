"use strict";

const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const i18nContext = {};
i18nContext.globalThis = i18nContext;
vm.runInNewContext(
  fs.readFileSync(path.join(__dirname, "..", "src", "settings-i18n.js"), "utf8"),
  i18nContext,
  { filename: "settings-i18n.js" },
);
test("all language packs define permissionAutomationCancel", () => {
  for (const [locale, dictionary] of Object.entries(i18nContext.ClawdSettingsI18n.STRINGS)) {
    assert.ok(
      Object.prototype.hasOwnProperty.call(dictionary, "permissionAutomationCancel"),
      `${locale} should define permissionAutomationCancel`,
    );
  }
});

class FakeElement {
  constructor() {
    this.children = [];
    this.parentNode = null;
    this.className = "";
    this.innerHTML = "";
    this.textContent = "";
  }
  appendChild(child) {
    child.parentNode = this;
    this.children.push(child);
    return child;
  }
  querySelector() { return null; }
  querySelectorAll() { return []; }
  addEventListener() {}
  setAttribute() {}
  removeAttribute() {}
  get isConnected() { return true; }
  classList = { add() {}, remove() {}, toggle() {}, contains() { return false; } };
}

test("mobile consent surfaces token-reset phase failure in the command error", async () => {
  const switchConfigs = new Map();
  let connectionInfoReads = 0;
  const settingsAPI = {
    command: async (_name, payload) => ({
      status: "error",
      message: "disk full",
      tokenReset: payload.resetAccess === true,
      rePairRequired: payload.resetAccess === true,
    }),
    getMobileConnectionInfo: async () => {
      connectionInfoReads++;
      return {
        status: "ok",
        port: 23334,
        pairCode: "ABCD1234",
        pairExpiresAt: 123456,
        lanIp: "192.0.2.10",
        pairUrl: `http://192.0.2.10:23334/mobile/?pair=ABCD1234`,
      };
    },
  };
  const context = vm.createContext({
    console,
    Promise,
    setTimeout: () => 1,
    clearTimeout() {},
    navigator: {},
    document: { createElement: () => new FakeElement() },
    window: { settingsAPI },
  });
  context.globalThis = context;
  const source = fs.readFileSync(
    path.join(__dirname, "..", "src", "settings-tab-mobile.js"),
    "utf8"
  );
  vm.runInContext(source, context, { filename: "settings-tab-mobile.js" });

  const strings = {
    ...i18nContext.ClawdSettingsI18n.STRINGS.en,
    mobilePermissionTokenResetFailure: "TOKEN RESET — RE-PAIR. ",
  };
  const core = {
    runtime: {},
    state: { snapshot: { mobilePreviewEnabled: true, mobilePermissionPreviewEnabled: false } },
    helpers: {
      t: (key) => strings[key] || key,
      escapeHtml: (value) => String(value),
      buildSwitchRow(config) {
        switchConfigs.set(config.key, config);
        return new FakeElement();
      },
      attachDescriptionDisclosure: (row) => row,
      buildDetailGroup: (_label, rows) => {
        const group = new FakeElement();
        for (const row of rows) group.appendChild(row);
        return group;
      },
      buildButton: () => new FakeElement(),
      setButtonState: () => {},
      buildStatusLine: () => ({ element: new FakeElement(), setStatus() {} }),
      showSettingsDialog: async () => "reset",
    },
  };
  context.ClawdSettingsTabMobile.init(core);
  context.ClawdSettingsTabMobile.renderChannelBody(new FakeElement());
  await Promise.resolve();
  assert.strictEqual(connectionInfoReads, 1);

  const config = switchConfigs.get("mobilePermissionPreviewEnabled");
  assert.ok(config, "permission child switch should be rendered");
  const result = await config.onToggle({ nextRaw: true });
  assert.strictEqual(result.status, "error");
  assert.strictEqual(result.tokenReset, true);
  assert.match(result.message, /TOKEN RESET — RE-PAIR/);
  assert.match(result.message, /disk full/);
  await Promise.resolve();
  assert.strictEqual(connectionInfoReads, 2, "reset failure must refresh stale pairing data");
});

for (const enabling of [false, true]) {
  test(`partial reset UI distinguishes ${enabling ? "enable preview" : "standalone reset"} and leaves preference unchanged`, async () => {
    const buttons = new Map(), configs = new Map(), dialogs = [], timers = [];
    const strings = i18nContext.ClawdSettingsI18n.STRINGS.zh;
    const result = { status: "error", message: "disk full", partialReset: true };
    let reads = 0, refreshes = 0;
    const snapshot = { mobilePreviewEnabled: true, mobilePermissionPreviewEnabled: !enabling };
    const context = vm.createContext({
      Promise, Date, console, navigator: {}, document: { createElement: () => new FakeElement(), visibilityState: "visible" },
      setTimeout(fn, delay) { timers.push({ fn, delay }); return timers.length; }, clearTimeout() {},
      window: { confirm: () => true, settingsAPI: {
        resetMobileAccess: async () => result, refreshMobilePairCode: async () => { refreshes++; return { status: "error", message: "refresh failed" }; },
        command: async () => result,
        getMobileConnectionInfo: async () => { reads++; return { status: "ok", port: 23334, lanIp: "192.0.2.1", pairCode: "ABCD1234", pairExpiresAt: 123456, pairUrl: "http://192.0.2.1:23334/mobile/?pair=ABCD1234" }; },
      } },
    });
    context.globalThis = context;
    vm.runInContext(fs.readFileSync(path.join(__dirname, "../src/settings-tab-mobile.js"), "utf8"), context);
    context.ClawdSettingsTabMobile.init({ state: { snapshot }, helpers: {
      t: (key) => strings[key],
      buildSwitchRow(config) { configs.set(config.key, config); return new FakeElement(); },
      attachDescriptionDisclosure() {}, buildDetailGroup(_label, rows) { const el = new FakeElement(); rows.forEach((r) => el.appendChild(r)); return el; },
      buildButton(config) { const el = new FakeElement(); el.addEventListener = (_name, fn) => { el.click = fn; }; buttons.set(config.labelKey, el); return el; },
      showSettingsDialog: async (config) => { dialogs.push(config); return "reset"; },
    } });
    context.ClawdSettingsTabMobile.renderChannelBody(new FakeElement());
    await Promise.resolve(); await Promise.resolve();
    assert.equal(reads, 1, "info without token must be ready");
    assert.ok(buttons.has("mobileRefreshPairCode")); assert.equal(buttons.has("mobileRegenerate"), false);
    if (enabling) {
      const feedback = await configs.get("mobilePermissionPreviewEnabled").onToggle({ nextRaw: true });
      assert.equal(feedback.partialReset, true); assert.match(feedback.message, /权限预览没有开启/);
    } else {
      buttons.get("mobileReset").click(); await Promise.resolve(); await Promise.resolve();
      assert.equal(dialogs.at(-1).title, strings.mobileReset);
      assert.equal(dialogs.at(-1).detail, strings.mobilePartialResetFailure);
      assert.doesNotMatch(dialogs.at(-1).detail, /权限预览没有开启/);
    }
    assert.equal(snapshot.mobilePermissionPreviewEnabled, !enabling);
    buttons.get("mobileRefreshPairCode").click(); await Promise.resolve(); await Promise.resolve();
    assert.equal(refreshes, 1);
    assert.equal(dialogs.at(-1).title, strings.mobileRefreshPairCode);
    assert.equal(dialogs.at(-1).detail, "refresh failed");
    const beforePoll = reads;
    timers.find((timer) => timer.delay === 5000).fn(); await Promise.resolve(); await Promise.resolve();
    assert.equal(reads, beforePoll + 1);
  });
}

test("all language packs define pairing and partial-reset messages", () => {
  for (const [locale, strings] of Object.entries(i18nContext.ClawdSettingsI18n.STRINGS)) {
    for (const key of ["mobileRefreshPairCode", "mobileConnPairCode", "mobileConnPairExpires", "mobilePartialResetFailure", "mobilePermissionPartialResetFailure", "mobileDismiss"]) {
      assert.equal(typeof strings[key], "string", `${locale}.${key}`); assert.ok(strings[key]);
    }
  }
});
