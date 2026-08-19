#!/usr/bin/env node
// T1 [regression/failure] — docs/code consistency. Covers R1.
// Run: node tests/t1_docs_consistency.js
const fs = require("fs");
const assert = require("assert");

const read = (f) => fs.readFileSync(f, "utf8");
const bg = read("background.js");
const sp = read("sidepanel.js");
const readme = read("README.md");

let failed = 0;
function check(name, fn) {
  try { fn(); console.log(`PASS ${name}`); }
  catch (e) { failed++; console.log(`FAIL ${name}: ${e.message}`); }
}

// A1: README Settings section default gateway URL matches DEFAULTS.gatewayUrl in code.
check("A1 README default gateway matches DEFAULTS.gatewayUrl", () => {
  const m = bg.match(/gatewayUrl:\s*"([^"]+)"/);
  assert.ok(m, "DEFAULTS.gatewayUrl not found in background.js");
  const settingsSection = readme.split("## Settings")[1].split("##")[0];
  assert.ok(
    settingsSection.includes(m[1]),
    `README Settings says wrong default; code says ${m[1]}`
  );
});

// A2: GATEWAY_CANDIDATES comment port roles match classifyGatewayInline roles.
check("A2 background.js port-role comment matches code", () => {
  const comment = bg.split("const GATEWAY_CANDIDATES")[0].split("\n").slice(-5).join("\n");
  assert.ok(!/20128[^.]*WebUI default/i.test(comment),
    "comment claims 20128 is WebUI default; code treats 9119 as WebUI");
  assert.ok(!/8642[^.]*WebUI default/i.test(comment),
    "comment claims 8642 is WebUI default; code treats 8642 as native API server");
});

// A3: README endpoint list matches endpoints actually called in code.
check("A3 README endpoints exist in code", () => {
  for (const ep of [
    "/api/sessions",            // POST create (README: /api/sessions/{id}/chat/stream)
    "/chat/stream",
    "/v1/chat/completions",
    "/api/config",
    "/api/available-models",
    "/api/skills",
    "/api/health",
  ]) {
    assert.ok(bg.includes(`"${ep}`) || bg.includes(ep), `endpoint ${ep} not found in background.js`);
  }
});

// A4: slash commands README documents palette keys that exist in sidepanel.js.
check("A4 palette keys documented", () => {
  assert.ok(sp.includes("ArrowUp") && sp.includes("ArrowDown"), "arrow nav missing");
  assert.ok(sp.includes("Escape"), "escape missing");
  assert.ok(sp.includes('startsWith("//")'), "// literal-slash escape missing");
  assert.ok(readme.includes("`//`"), "README missing // doc");
});

console.log(failed ? `\n${failed} FAILED` : "\nALL PASS");
process.exit(failed ? 1 : 0);
