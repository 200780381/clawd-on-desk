"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const {
  auditSvgCompositing,
  RULES,
} = require("./helpers/svg-animation-compositing");

const REPO_ROOT = path.join(__dirname, "..");
const THEME_PATH = path.join(REPO_ROOT, "themes", "clawd", "theme.json");
const SVG_DIR = path.join(REPO_ROOT, "assets", "svg");

function svg(body) {
  return `<svg xmlns="http://www.w3.org/2000/svg">${body}</svg>`;
}

function audit(markup) {
  return auditSvgCompositing(markup);
}

function violationsOf(result, ruleId) {
  return result.violations.filter((violation) => violation.id === ruleId);
}

function readMarkup(filePath) {
  return fs.readFileSync(filePath, "utf8").replace(/\r\n/g, "\n");
}

function formatViolation(file, violation) {
  const property = violation.property === null ? "(none)" : `"${violation.property}"`;
  return `${file}: [${violation.rule} ${violation.id}] ${violation.element}`
    + ` — animation "${violation.animation}", property ${property}\n  ${violation.message}`;
}

function formatNote(file, note) {
  if (note.type === "unsupported-selector") {
    return `${file}: [note ${note.type}] "${note.selector}" — ${note.reason}`;
  }
  const value = note.value || note.href || "";
  return `${file}: [note ${note.type}] ${note.element || "(unknown element)"}`
    + ` — value "${value}"${note.reason ? `; ${note.reason}` : ""}`;
}

function assertR2Move(result) {
  const violations = violationsOf(result, RULES.R2.id);
  assert.equal(violations.length, 1);
  assert.equal(violations[0].animation, "move");
  assert.equal(violations[0].property, "transform");
}

// ---------------------------------------------------------------------------
// Part 1: minimal inline examples for each rule. Every bad case must report the
// rule, and every paired good case must stay quiet.
// ---------------------------------------------------------------------------

test("R1 flags keyframe properties the compositor cannot animate", () => {
  const result = audit(svg(`
    <style>
      .pulse { animation: glow 1s infinite; }
      @keyframes glow {
        0%, 100% { fill: #FF5252; }
        50% { fill: #FFF59D; }
      }
    </style>
    <rect class="pulse" width="4" height="4"/>
  `));

  const violations = violationsOf(result, RULES.R1.id);
  assert.equal(violations.length, 1);
  assert.equal(violations[0].rule, "R1");
  assert.equal(violations[0].element, "rect.pulse");
  assert.equal(violations[0].animation, "glow");
  assert.equal(violations[0].property, "fill");
});

test("R1 rejects every non-allowlisted property, not just colors", () => {
  const forbidden = ["fill", "visibility", "stroke-dashoffset", "transform-origin", "filter", "fill-opacity", "stroke"];
  for (const property of forbidden) {
    const result = audit(svg(`
      <style>
        .bit { animation: move 1s infinite; }
        @keyframes move { to { ${property}: 0.5; } }
      </style>
      <rect class="bit"/>
    `));
    assert.equal(
      violationsOf(result, RULES.R1.id).length,
      1,
      `${property} should be rejected by the allowlist`,
    );
  }
});

test("R1 accepts only transform and opacity", () => {
  const result = audit(svg(`
    <style>
      .bit { animation: move 1s infinite; }
      @keyframes move {
        0% { transform: translateX(0); opacity: 0; }
        100% { transform: translateX(2px); opacity: 1; }
      }
    </style>
    <rect class="bit"/>
  `));

  assert.deepEqual(result.violations, []);
});

test("R1 rejects independent translate, rotate, and scale on SVG targets", () => {
  for (const property of ["translate", "rotate", "scale"]) {
    const result = audit(svg(`
      <style>
        .bit { animation: move 1s infinite; }
        @keyframes move { to { ${property}: 1; } }
      </style>
      <rect class="bit"/>
    `));
    const violations = violationsOf(result, RULES.R1.id);
    assert.equal(violations.length, 1, `${property} should be rejected`);
    assert.equal(violations[0].property, property);
  }
});

test("R1 sees the same bad stylesheet wrapped in CDATA", () => {
  const css = `
    .pulse { animation: glow 1s infinite; }
    @keyframes glow { 50% { fill: #FFF59D; } }
  `;
  const bare = audit(svg(`<style>${css}</style><rect class="pulse"/>`));
  const cdata = audit(svg(`<style><![CDATA[${css}]]></style><rect class="pulse"/>`));

  for (const [kind, result] of [["bare text", bare], ["CDATA", cdata]]) {
    const violations = violationsOf(result, RULES.R1.id);
    assert.equal(violations.length, 1, `${kind} should report R1`);
    assert.equal(violations[0].property, "fill", `${kind} should see the fill property`);
  }
});

test("duplicate @keyframes merge properties instead of overriding", () => {
  const result = audit(svg(`
    <style>
      rect { animation: k 1s infinite; }
      @keyframes k { to { fill: red; } }
      @media not all {
        @keyframes k { to { opacity: 0; } }
      }
    </style>
    <rect width="4" height="4"/>
  `));

  const violations = violationsOf(result, RULES.R1.id);
  assert.equal(violations.length, 1);
  assert.equal(violations[0].property, "fill");
});

test("keyframe metadata is not treated as an animated property", () => {
  const metadataOnly = audit(svg(`
    <style>
      .bit { animation: move 1s infinite; }
      @keyframes move {
        to {
          animation-timing-function: steps(2, end);
          animation-composition: add;
          transform: translateX(1px);
        }
      }
    </style>
    <rect class="bit"/>
  `));
  assert.deepEqual(violationsOf(metadataOnly, RULES.R1.id), []);

  const withFill = audit(svg(`
    <style>
      .bit { animation: move 1s infinite; }
      @keyframes move {
        to {
          animation-timing-function: steps(2, end);
          fill: red;
        }
      }
    </style>
    <rect class="bit"/>
  `));
  const violations = violationsOf(withFill, RULES.R1.id);
  assert.equal(violations.length, 1);
  assert.equal(violations[0].property, "fill");
});

test("R2 flags transform animation on a <use> that carries x/y", () => {
  const result = audit(svg(`
    <style>
      .bit { animation: float 1.5s infinite; }
      @keyframes float { 100% { transform: translateY(-17px); } }
    </style>
    <defs><g id="packet"><rect width="1" height="1"/></g></defs>
    <use href="#packet" x="3" y="7" class="bit"/>
  `));

  const violations = violationsOf(result, RULES.R2.id);
  assert.equal(violations.length, 1);
  assert.equal(violations[0].element, "use.bit");
  assert.equal(violations[0].animation, "float");
  assert.equal(violations[0].property, "transform");
});

test("R2 allows a <use> with x/y that only animates opacity", () => {
  const result = audit(svg(`
    <style>
      .bit { animation: fade 1.5s infinite; }
      @keyframes fade { 100% { opacity: 0; } }
    </style>
    <defs><g id="packet"><rect width="1" height="1"/></g></defs>
    <use href="#packet" x="3" y="7" class="bit"/>
  `));

  assert.equal(violationsOf(result, RULES.R2.id).length, 0);
});

test("R2 allows transform animation on a <use> without x/y", () => {
  const result = audit(svg(`
    <style>
      .spark { animation: spark 1.2s infinite; }
      @keyframes spark { 50% { transform: translate(4px, -6px) scale(1); } }
    </style>
    <defs><g id="pixel"><rect width="1" height="1"/></g></defs>
    <use href="#pixel" class="spark"/>
  `));

  assert.equal(violationsOf(result, RULES.R2.id).length, 0);
});

test("R2 ignores an explicit zero x/y", () => {
  const result = audit(svg(`
    <style>
      .bit { animation: float 1s infinite; }
      @keyframes float { 100% { transform: translateY(-2px); } }
    </style>
    <defs><g id="packet"><rect width="1" height="1"/></g></defs>
    <use href="#packet" x="0" y="0" class="bit"/>
  `));

  assert.equal(violationsOf(result, RULES.R2.id).length, 0);
});

const ANIMATION_KEYFRAMES = `
  @keyframes fade { to { opacity: 0.5; } }
  @keyframes move { to { transform: translateX(10px); } }
`;

function auditUseWithRule(rule) {
  return audit(svg(`
    <style>
      ${rule}
      ${ANIMATION_KEYFRAMES}
    </style>
    <defs><path id="p" d="M0 0H4V4H0Z"/></defs>
    <use href="#p" x="3" class="u"/>
  `));
}

test("declaration normalization: !important in an animation-name list", () => {
  const result = auditUseWithRule(`
    .u {
      animation-name: fade, move !important;
      animation-duration: 1s;
      animation-iteration-count: infinite;
    }
  `);
  assertR2Move(result);
});

test("declaration normalization: !important attached to a shorthand name", () => {
  assertR2Move(auditUseWithRule(".u { animation: 1s infinite move!important; }"));
});

test("declaration normalization: comments inside an inline style", () => {
  const result = audit(svg(`
    <style>${ANIMATION_KEYFRAMES}</style>
    <defs><path id="p" d="M0 0H4V4H0Z"/></defs>
    <use href="#p" x="3" style="animation:/* note */move 1s infinite"/>
  `));
  assertR2Move(result);
});

test("declaration normalization: an arbitrary function token is skipped", () => {
  assertR2Move(auditUseWithRule(".u { animation: 1s linear(0, 1) move infinite; }"));
});

test("declaration normalization: calc() is skipped", () => {
  assertR2Move(auditUseWithRule(".u { animation: calc(1s) move infinite; }"));
});

test("declaration normalization: -webkit-animation is an alias", () => {
  assertR2Move(auditUseWithRule(".u { -webkit-animation: move 1s infinite; }"));
});

test("R2 reads x/y from inline style", () => {
  const result = audit(svg(`
    <style>${ANIMATION_KEYFRAMES}</style>
    <defs><path id="p" d="M0 0H4V4H0Z"/></defs>
    <use href="#p" style="x:3px;animation:move 1s infinite"/>
  `));
  assertR2Move(result);
});

test("R2 reads x/y from a matching style rule", () => {
  const result = audit(svg(`
    <style>
      .b { x: 3px; }
      .u { animation: move 1s infinite; }
      ${ANIMATION_KEYFRAMES}
    </style>
    <defs><path id="p" d="M0 0H4V4H0Z"/></defs>
    <use href="#p" class="b u"/>
  `));
  assertR2Move(result);
});

test("R3 flags animation on a referenced element or its descendants", () => {
  const result = audit(svg(`
    <style>
      .twinkle { animation: flicker 1.5s infinite step-end; }
      @keyframes flicker { 20% { opacity: 1; } }
    </style>
    <defs>
      <g id="sparkle">
        <rect class="twinkle" width="1" height="1"/>
      </g>
    </defs>
    <use href="#sparkle" x="3" y="4"/>
  `));

  const violations = violationsOf(result, RULES.R3.id);
  assert.equal(violations.length, 1);
  assert.equal(violations[0].element, "rect.twinkle");
  assert.equal(violations[0].animation, "flicker");
  assert.match(violations[0].message, /#sparkle/);
});

test("R3 also follows xlink:href references", () => {
  const result = audit(svg(`
    <style>
      .twinkle { animation: flicker 1s infinite; }
      @keyframes flicker { 100% { opacity: 1; } }
    </style>
    <defs>
      <g id="sparkle"><rect class="twinkle"/></g>
    </defs>
    <use xmlns:xlink="http://www.w3.org/1999/xlink" xlink:href="#sparkle"/>
  `));

  assert.equal(violationsOf(result, RULES.R3.id).length, 1);
});

test("R3 decodes URL-encoded href fragments before looking up ids", () => {
  const result = audit(svg(`
    <style>@keyframes fade { to { opacity: 0; } }</style>
    <defs>
      <rect id="packet" width="4" height="4" style="animation:fade 1s infinite"/>
    </defs>
    <use href="#%70acket"/>
  `));

  const violations = violationsOf(result, RULES.R3.id);
  assert.equal(violations.length, 1);
  assert.equal(violations[0].element, "rect#packet");
});

test("R3 notes href fragments that cannot be resolved", () => {
  const result = audit(svg(`
    <use href="#missing"/>
    <use href="#%E0%A4%A"/>
  `));

  const notes = result.notes.filter((note) => note.type === "unresolved-use-target");
  assert.equal(notes.length, 2);
  assert.deepEqual(notes.map((note) => note.href).sort(), ["#%E0%A4%A", "#missing"]);
  assert.ok(notes.every((note) => note.reason && note.hint));
});

test("R3 allows a static <use> target", () => {
  const result = audit(svg(`
    <style>
      .user { animation: fade 1s infinite; }
      @keyframes fade { 100% { opacity: 0; } }
    </style>
    <defs><g id="packet"><rect width="1" height="1"/></g></defs>
    <use href="#packet" class="user"/>
  `));

  assert.equal(violationsOf(result, RULES.R3.id).length, 0);
});

test("R4 flags each SMIL animation element", () => {
  for (const tag of ["animate", "animateTransform", "animateMotion", "set"]) {
    const result = audit(svg(`<rect width="1" height="1"><${tag}/></rect>`));
    const violations = violationsOf(result, RULES.R4.id);
    assert.equal(violations.length, 1, `${tag} should be rejected`);
    assert.equal(violations[0].animation, `<${tag.toLowerCase()}>`);
  }
});

test("R5 flags a nested <svg> inside the root <svg>", () => {
  const result = audit(svg(`
    <g>
      <svg id="inner"><rect width="1" height="1"/></svg>
    </g>
  `));

  const violations = violationsOf(result, RULES.R5.id);
  assert.equal(violations.length, 1);
  assert.equal(violations[0].element, "svg#inner");
});

test("R5 allows a single root <svg>", () => {
  const result = audit(svg(`<g><rect width="1" height="1"/></g>`));
  assert.equal(violationsOf(result, RULES.R5.id).length, 0);
});

test("selectors match the subject of descendant and child combinators", () => {
  const result = audit(svg(`
    <style>
      .a .b { animation: fade 1s infinite; }
      .c > .d { animation: fade 1s infinite; }
      @keyframes fade { 100% { opacity: 0; } }
    </style>
    <g class="a"><rect class="b"/></g>
    <g class="c"><rect class="d"/></g>
    <rect class="b"/>
  `));

  const animated = result.animations.map((entry) => entry.element).sort();
  assert.deepEqual(animated, ["rect.b", "rect.b", "rect.d"]);
});

test("a selector list applies each subject it names", () => {
  const result = audit(svg(`
    <style>
      .a, .b { animation: fade 1s infinite; }
      @keyframes fade { 100% { opacity: 0; } }
    </style>
    <rect class="a"/><rect class="b"/><rect class="c"/>
  `));

  const animated = result.animations.map((entry) => entry.element).sort();
  assert.deepEqual(animated, ["rect.a", "rect.b"]);
});

test("@media blocks are parsed recursively for rules and keyframes", () => {
  const bad = audit(svg(`
    <style>
      @media (prefers-reduced-motion: no-preference) {
        .pulse { animation: glow 1s infinite; }
        @keyframes glow { 50% { fill: #FFF59D; } }
      }
    </style>
    <rect class="pulse"/>
  `));
  const badViolations = violationsOf(bad, RULES.R1.id);
  assert.equal(badViolations.length, 1);
  assert.equal(badViolations[0].property, "fill");

  const animated = audit(svg(`
    <style>
      @media (min-width: 1px) {
        .a { animation: fade 1s infinite; }
        @keyframes fade { 100% { opacity: 0; } }
      }
    </style>
    <rect class="a"/>
  `));
  assert.deepEqual(animated.animations.map((entry) => entry.element), ["rect.a"]);
  assert.deepEqual(animated.violations, []);
});

test("the animation shorthand finds the name at the start, middle, or end", () => {
  const result = audit(svg(`
    <style>
      .start { animation: fade 1s infinite; }
      .middle { animation: 1s ease-in fade infinite; }
      .end { animation: 1s infinite cubic-bezier(0.2, 0, 0.8, 1) fade; }
      @keyframes fade { 100% { opacity: 0; } }
    </style>
    <rect class="start"/><rect class="middle"/><rect class="end"/>
  `));

  assert.deepEqual(
    result.animations.map((entry) => `${entry.element}:${entry.name}`).sort(),
    ["rect.end:fade", "rect.middle:fade", "rect.start:fade"],
  );
});

test("animation-name declarations and inline style animations are detected", () => {
  const result = audit(svg(`
    <style>
      .named { animation-name: fade; animation-duration: 1s; }
      @keyframes fade { 100% { opacity: 0; } }
    </style>
    <rect class="named"/>
    <rect style="animation: fade 1s infinite"/>
  `));

  assert.deepEqual(
    result.animations.map((entry) => entry.element).sort(),
    ["rect", "rect.named"],
  );
});

test("animation names without matching @keyframes are ignored", () => {
  const result = audit(svg(`
    <style>.missing { animation: not-defined 1s infinite; }</style>
    <rect class="missing"/>
  `));

  assert.deepEqual(result.animations, []);
  assert.deepEqual(result.violations, []);
});

test("a shorthand whose name is only var() leaves an unresolved note", () => {
  const result = audit(svg(`
    <style>.pulse { animation: var(--anim) 1s infinite; }</style>
    <rect class="pulse"/>
  `));

  assert.deepEqual(result.animations, []);
  const notes = result.notes.filter((note) => note.type === "unresolved-animation-name");
  assert.equal(notes.length, 1);
  assert.equal(notes[0].selector, ".pulse");
  assert.equal(notes[0].element, "rect.pulse");
  assert.match(notes[0].value, /var\(--anim\)/);
  assert.match(notes[0].reason, /var\(\)/);
  assert.match(notes[0].hint, /explicit animation name/);
});

test("CSS-wide animation values leave an unsupported-animation-value note", () => {
  for (const keyword of ["inherit", "initial", "unset", "revert", "revert-layer"]) {
    const result = audit(svg(`
      <style>.pulse { animation: ${keyword}; }</style>
      <rect class="pulse"/>
    `));
    const notes = result.notes.filter((note) => note.type === "unsupported-animation-value");
    assert.equal(notes.length, 1, `${keyword} should leave a note`);
    assert.equal(notes[0].selector, ".pulse");
    assert.equal(notes[0].value, keyword);
    assert.match(notes[0].reason, /inherit/);
    assert.ok(notes[0].hint);
  }
});

test("CSS nesting leaves a note and skips the containing rule", () => {
  const result = audit(svg(`
    <style>
      @keyframes fade { to { opacity: 0; } }
      .a {
        animation: fade 1s infinite;
        .b { animation: fade 1s infinite; }
      }
    </style>
    <rect class="a"/>
  `));

  assert.deepEqual(result.animations, []);
  const notes = result.notes.filter((note) => note.type === "unsupported-nesting");
  assert.equal(notes.length, 1);
  assert.equal(notes[0].selector, ".a");
  assert.match(notes[0].reason, /nesting/i);
  assert.ok(notes[0].hint);
});

test("unsupported selectors are reported instead of silently skipped", () => {
  const result = audit(svg(`
    <style>
      .a:hover { animation: fade 1s infinite; }
      .b[data-x] { animation: fade 1s infinite; }
      @keyframes fade { 100% { opacity: 0; } }
    </style>
    <rect class="a"/><rect class="b" data-x="1"/>
  `));

  assert.equal(result.violations.length, 0);
  assert.deepEqual(
    result.notes.map((note) => [note.type, note.selector]),
    [
      ["unsupported-selector", ".a:hover"],
      ["unsupported-selector", ".b[data-x]"],
    ],
  );
});

// ---------------------------------------------------------------------------
// Part 3: the shipped Clawd theme. Every declared OBJECT-channel asset must be
// clean, and R6 keeps the sampling declarations in sync with that list.
// ---------------------------------------------------------------------------

test("every Clawd OBJECT-channel asset is compositor-safe", () => {
  const theme = JSON.parse(readMarkup(THEME_PATH));
  const files = theme.rendering && Array.isArray(theme.rendering.objectChannelFiles)
    ? theme.rendering.objectChannelFiles
    : [];
  assert.ok(files.length > 0, "themes/clawd/theme.json declares no objectChannelFiles");

  const failures = [];
  for (const file of files) {
    const result = audit(readMarkup(path.join(SVG_DIR, file)));
    if (result.animations.length === 0) {
      failures.push(
        `${file}: no animations detected. If this asset is genuinely static it`
        + ` does not belong in objectChannelFiles; otherwise the audit cannot`
        + ` see its stylesheet — check CDATA, @media/@supports at-rules, and`
        + ` selector syntax first.`,
      );
    }
    for (const violation of result.violations) failures.push(formatViolation(file, violation));
    for (const note of result.notes) failures.push(formatNote(file, note));
  }

  assert.equal(
    failures.length,
    0,
    `OBJECT-channel SVGs must stay compositor-friendly:\n${failures.join("\n")}`,
  );
});

test("R6 keeps objectChannelFiles, discreteSampling, and assets/svg consistent", () => {
  const theme = JSON.parse(readMarkup(THEME_PATH));
  const rendering = theme.rendering || {};
  const objectFiles = Array.isArray(rendering.objectChannelFiles) ? rendering.objectChannelFiles : [];
  const sampling = rendering.discreteSampling && typeof rendering.discreteSampling === "object"
    ? rendering.discreteSampling
    : {};

  const sampledFiles = Object.keys(sampling);
  const duplicateObjectFiles = objectFiles.filter((file, index) => objectFiles.indexOf(file) !== index);
  const objectWithoutSampling = objectFiles.filter((file) => !sampledFiles.includes(file));
  const samplingWithoutObject = sampledFiles.filter((file) => !objectFiles.includes(file));
  const missingAssets = [...new Set([...objectFiles, ...sampledFiles])]
    .filter((file) => !fs.existsSync(path.join(SVG_DIR, file)));

  assert.deepEqual(
    {
      duplicateObjectFiles,
      objectWithoutSampling,
      samplingWithoutObject,
      missingAssets,
    },
    {
      duplicateObjectFiles: [],
      objectWithoutSampling: [],
      samplingWithoutObject: [],
      missingAssets: [],
    },
    "objectChannelFiles and discreteSampling must list the same existing SVG basenames",
  );
});
