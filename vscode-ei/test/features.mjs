// Tests for examples-as-tests, ambiguity linter, multi-file modules,
// and the English debugger. Uses the http engine (qwen, temperature 0).
import { execFileSync, spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { compile, runLint } from "../out/core/compiler.js";
import { instrument } from "../out/core/debug.js";
import { loadCache, saveCache, stmtKey } from "../out/core/cache.js";

const cfg = {
  engine: process.env.EI_TEST_ENGINE || "http",
  httpUrl: "http://192.168.2.24:8000/v1/chat/completions",
  httpApiKey: "inktype-local",
  httpModel: "qwen/qwen3.8-27b",
  piModel: process.env.EI_TEST_PI_MODEL || "",
  piModeFile: path.resolve(import.meta.dirname, "..", "..", "ei-mode.json"),
};

let failures = 0;
const check = (name, ok, extra = "") => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${extra ? "  — " + extra : ""}`);
  if (!ok) failures++;
};
const dir = "/tmp/eitest-features";
fs.rmSync(dir, { recursive: true, force: true });
fs.mkdirSync(dir, { recursive: true });
const write = (name, text) => { const p = path.join(dir, name); fs.writeFileSync(p, text); return p; };
const progress = m => console.log("  …", m);

// ------------------------------------------------- 1. examples as tests
const exFile = write("greet.ei", `This program is written in Python.

To welcome someone:
    give back "Hello, " plus that person's name plus "!"

Print the welcome for "Maxime".

For example, welcoming "Ada" must give exactly "Hello, Ada!".
`);
console.log("example test: compiling…");
const ex = await compile(exFile, fs.readFileSync(exFile, "utf8"), cfg, { translateMissing: true, lint: false, onProgress: progress });
check("examples: survey finds the expectation", ex.survey.examples.length === 1, JSON.stringify(ex.survey.examples));
check("examples: test script produced", !!ex.testScript && ex.testScript.includes("EI-TEST"));
check("examples: main script has no assertion harness", !ex.script.includes("EI-TEST"));
check("examples: no diagnostics", !ex.diagnostics.some(d => d.severity === "error"), JSON.stringify(ex.diagnostics));
let testRun = spawnSync("python3", ["-c", ex.testScript], { timeout: 30000 });
let testOut = String(testRun.stdout);
check("examples: check passes", /EI-TEST \d+ PASS/.test(testOut), testOut.trim().split("\n").pop());
check("examples: test exit code 0", testRun.status === 0);

// break the definition through its pin -> the example must fail
const exCache = loadCache(exFile);
const defKey = Object.keys(exCache.pins).find(k => exCache.pins[k].stmt.startsWith("To welcome"));
exCache.pins[defKey].code = 'def welcome(name):\n    return f"Goodbye, {name}?"';
saveCache(exFile, exCache);
const exBroken = await compile(exFile, fs.readFileSync(exFile, "utf8"), cfg, { translateMissing: true, lint: false });
testRun = spawnSync("python3", ["-c", exBroken.testScript], { timeout: 30000 });
testOut = String(testRun.stdout);
check("examples: broken code fails the check", /EI-TEST \d+ FAIL/.test(testOut), testOut.trim().split("\n").pop());
check("examples: failing tests exit 1", testRun.status === 1);

// ------------------------------------------------- 2. ambiguity linter
console.log("lint: running…");
const vague = `Load the file.
Delete it.
Wait a few seconds, then do the same to the other one.
`;
const warnings = await runLint(vague, cfg);
check("lint: flags ambiguous prose", warnings.length >= 1, JSON.stringify(warnings));
const clear = `Print the number 7.
`;
const clean = await runLint(clear, cfg);
check("lint: accepts clear prose", clean.length === 0, JSON.stringify(clean));

// ------------------------------------------------- 3. multi-file modules
write("text-utils.ei", `This Python module provides text helpers.

To shout some text:
    give back that text in upper case with an exclamation mark added
`);
const mainFile = write("main.ei", `This Python program uses the helpers in ./text-utils.ei.

Print the shout of "hello world".
`);
console.log("modules: compiling main…");
const mod = await compile(mainFile, fs.readFileSync(mainFile, "utf8"), cfg, { translateMissing: true, lint: false, onProgress: progress });
check("modules: dependency surveyed", mod.survey.uses.some(u => u.includes("text-utils.ei")), JSON.stringify(mod.survey.uses));
check("modules: module compiled and registered", mod.modules.length === 1 && mod.modules[0].name === "text_utils", JSON.stringify(mod.modules.map(m => m.name)));
check("modules: artifact written", fs.existsSync(path.join(dir, ".ei-build", "text_utils.py")));
check("modules: import in prelude", mod.script.includes("import text_utils"));
check("modules: brief describes the API in English", mod.briefs.includes("text_utils.shout"), mod.briefs.trim().split("\n").slice(0, 3).join(" | "));
check("modules: no diagnostics", !mod.diagnostics.some(d => d.severity === "error"), JSON.stringify(mod.diagnostics));
const modOut = execFileSync("python3", ["-c", mod.script], { timeout: 30000 }).toString();
check("modules: program runs through the module", modOut.includes("HELLO WORLD!"), modOut.trim());
// second compile: dependency is warm, no model needed
const t0 = Date.now();
await compile(mainFile, fs.readFileSync(mainFile, "utf8"), cfg, { translateMissing: true, lint: false });
check("modules: recompile is incremental", Date.now() - t0 < 4000, `${Date.now() - t0}ms`);

// cycle detection (no model needed: inject surveys into the sidecars)
const aFile = write("a.ei", "This Python module uses ./b.ei.\n\nPrint 1.\n");
const bFile = write("b.ei", "This Python module uses ./a.ei.\n\nPrint 2.\n");
for (const [f, dep] of [[aFile, "./b.ei"], [bFile, "./a.ei"]]) {
  const c = loadCache(f);
  const { sha } = await import("../out/core/cache.js");
  c.survey = { key: sha(`http:${cfg.httpModel}\u0000` + fs.readFileSync(f, "utf8")).slice(0, 24), value: { target: "python", preambleEnd: 1, uses: [dep], definitions: [], examples: [] } };
  saveCache(f, c);
}
const cyc = await compile(aFile, fs.readFileSync(aFile, "utf8"), cfg, { translateMissing: true, lint: false });
check("modules: cycle detected", cyc.diagnostics.some(d => d.code === "module-cycle"), JSON.stringify(cyc.diagnostics.map(d => d.code)));

// ------------------------------------------------- 4. English debugger
const dbg = instrument(ex);
check("debug: pauses inserted before statements", (dbg.match(/__ei_pause\(/g) || []).length >= ex.blocks.filter(b => b.code).length + 1);
check("debug: shows the English line", dbg.includes('__ei_pause(6, "Print the welcome'), "");
const dbgRun = spawnSync("python3", ["-c", dbg], { input: "c\n", timeout: 30000 });
const dbgOut = String(dbgRun.stdout);
check("debug: banner appears and program continues", dbgOut.includes("[ei] line") && dbgOut.includes("Hello, Maxime!"), dbgOut.trim().split("\n").slice(0, 2).join(" | "));
check("debug: exits cleanly", dbgRun.status === 0);
const stepRun = spawnSync("python3", ["-c", dbg], { input: "\n".repeat(20), timeout: 30000 });
check("debug: stepping reaches the end", String(stepRun.stdout).includes("Hello, Maxime!"));

console.log(failures ? `\n${failures} FAILURES` : "\nALL FEATURE TESTS PASS");
process.exit(failures ? 1 : 0);
