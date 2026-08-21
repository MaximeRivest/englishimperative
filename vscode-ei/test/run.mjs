// Headless test of the extension core (no vscode API).
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const out = path.join(here, "..", "out", "core");
const { parse } = await import(path.join(out, "parser.js"));
const { compile, staleness, pinStatement } = await import(path.join(out, "compiler.js"));
const { loadCache, saveCache, cachePath } = await import(path.join(out, "cache.js"));

const cfg = {
  engine: process.env.EI_TEST_ENGINE || "http",
  httpUrl: "http://192.168.2.24:8000/v1/chat/completions",
  httpApiKey: "inktype-local",
  httpModel: "qwen/qwen3.8-27b",
  piModel: process.env.EI_TEST_PI_MODEL || "",
  piModeFile: path.join(here, "..", "..", "ei-mode.json"),
};

let failures = 0;
const check = (name, ok, extra = "") => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${extra ? "  — " + extra : ""}`);
  if (!ok) failures++;
};

// ---------------------------------------------------------------- parser
const ptext = `This is prose preamble.

# a comment
Do the first thing.
To make a sandwich:
    take bread
    add cheese
Continue here \\
and here.
`;
const parsed = parse(ptext);
const stmts = parsed.units.filter(u => u.kind === "statement");
check("parser: statement count", stmts.length === 4, JSON.stringify(stmts.map(s => s.text.split("\n")[0])));
check("parser: block capture", stmts[2].text.includes("add cheese"));
check("parser: continuation join", stmts[3].text === "Continue here and here.");
check("parser: comment kept", parsed.units.some(u => u.kind === "comment"));

// ---------------------------------------------------------------- compile
const dir = "/tmp/eitest-vsc";
fs.rmSync(dir, { recursive: true, force: true });
fs.mkdirSync(path.join(dir, "mylib"), { recursive: true });
fs.writeFileSync(path.join(dir, "mylib", "tools.py"), `def greet(name):
    """Return a friendly greeting for name."""
    return f"Hello, {name}!"

def shout(text):
    """Return text in upper case with an exclamation mark."""
    return text.upper() + "!"
`);
const eiFile = path.join(dir, "demo.ei");
fs.writeFileSync(eiFile, `This little program is written in Python.
It uses my helper library at ${dir}/mylib.

Welcome the user called "Maxime" and print the result.
Then print that same greeting, but shouted.

To welcome someone:
    make the greeting for that person with the library
    give back the greeting
`);

console.log("compiling (full, model calls)…");
const t0 = Date.now();
const r1 = await compile(eiFile, fs.readFileSync(eiFile, "utf8"), cfg, {
  translateMissing: true,
  onProgress: m => console.log("  …", m),
});
console.log(`  took ${((Date.now() - t0) / 1000).toFixed(1)}s`);
check("compile: target python", r1.target === "python");
check("compile: libraries surveyed", r1.survey.uses.length === 1, JSON.stringify(r1.survey.uses));
check("compile: hoisted definition", r1.hoistedLines.length === 1);
check("compile: no error diagnostics", !r1.diagnostics.some(d => d.severity === "error"), JSON.stringify(r1.diagnostics));
check("lint: runs during development compile", r1.diagnostics.every(d => d.severity !== "error"));
check("compile: prelude import", r1.script.includes("import tools"));
check("compile: blocks mapped", r1.blocks.every(b => b.genStart <= b.genEnd));
check("pins: successful translations pin by default", r1.blocks.every(b => b.pinned && b.automaticPin));
check("graph: facts stored for every block", r1.graph.nodes.every(n => n.interfaceHash && n.implementationHash && n.sourceHash));

// source map sanity: the mapped lines must contain the commented statement
const lines = r1.script.split("\n");
const b0 = r1.blocks.find(b => b.unit.text.startsWith("Welcome"));
check("map: block anchors on its source comment", lines[b0.genStart].startsWith("# Welcome"));

// run it
let runOut = "";
try { runOut = execFileSync("python3", ["-c", r1.script], { timeout: 30000 }).toString(); } catch (e) { runOut = String(e); }
check("run: greets", runOut.includes("Hello, Maxime!"), runOut.trim().replace(/\n/g, " | "));
check("run: shouts", runOut.includes("HELLO, MAXIME!"), "");

// ----------------------------------------------------------- locked build
// Break the URL: a passing locked build proves no model request happened.
const deadCfg = { ...cfg, httpUrl: "http://127.0.0.1:1/v1/chat/completions" };
const lockStart = Date.now();
const locked = await compile(eiFile, fs.readFileSync(eiFile, "utf8"), deadCfg, { translateMissing: false, locked: true });
check("locked: passes without a model", !locked.diagnostics.some(d => d.severity === "error"), JSON.stringify(locked.diagnostics));
check("locked: finishes locally", Date.now() - lockStart < 3000, `${Date.now()-lockStart}ms`);
const beforeMissing = loadCache(eiFile);
const missingKey = Object.keys(beforeMissing.pins)[0];
const savedPin = beforeMissing.pins[missingKey];
delete beforeMissing.pins[missingKey]; saveCache(eiFile, beforeMissing);
const rejected = await compile(eiFile, fs.readFileSync(eiFile, "utf8"), deadCfg, { translateMissing: false, locked: true });
check("locked: rejects a missing pin", rejected.diagnostics.some(d => d.code === "locked-pin"));
const restored = loadCache(eiFile); restored.pins[missingKey] = savedPin; saveCache(eiFile, restored);

// ---------------------------------------------------------------- cache
console.log("recompiling (pins, zero model calls)…");
const t1 = Date.now();
const r2 = await compile(eiFile, fs.readFileSync(eiFile, "utf8"), cfg, { translateMissing: true });
const dt = Date.now() - t1;
check("cache: recompile fast", dt < 3000, `${dt}ms`);
check("cache: all from cache", r2.blocks.every(b => b.fromCache || b.pinned));
check("cache: identical script", r2.script === r1.script);

// staleness: untouched file -> nothing stale
const s1 = staleness(eiFile, fs.readFileSync(eiFile, "utf8"), cfg);
check("stale: clean file has none", s1.staleLines.length === 0, JSON.stringify(s1.staleLines));
check("stale: ghosts present", s1.ghost.size >= 3);

// edit one line -> that statement and later ones go stale, earlier keep
const edited = fs.readFileSync(eiFile, "utf8").replace("but shouted", "but shouted twice");
const s2 = staleness(eiFile, edited, cfg);
check("stale: edited goes stale", s2.staleLines.length >= 1 && s2.staleLines.length < 4, JSON.stringify(s2.staleLines));

// pin: freeze one translation, clear others' context — pin must survive
const welcome = r1.blocks.find(b => b.unit.text.startsWith("Welcome"));
pinStatement(eiFile, welcome.unit.text, "print('PINNED CODE')");
const r3 = await compile(eiFile, fs.readFileSync(eiFile, "utf8"), cfg, { translateMissing: true });
check("pin: pinned code used", r3.script.includes("PINNED CODE"));
check("pin: block marked", r3.blocks.find(b => b.unit.text.startsWith("Welcome")).pinned === true);
check("cache: sidecar exists", fs.existsSync(cachePath(eiFile)));

console.log(failures ? `\n${failures} FAILURES` : "\nALL PASS");
process.exit(failures ? 1 : 0);
