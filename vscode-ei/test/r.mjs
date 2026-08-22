// R target: survey inference, definition + decision prose, example checks,
// execution via Rscript, and a no-model locked build.
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { compile } from "../out/core/compiler.js";
import { loadCache } from "../out/core/cache.js";

const cfg = {
  engine: "http",
  httpUrl: "http://192.168.2.24:8000/v1/chat/completions",
  httpApiKey: "inktype-local",
  httpModel: "qwen/qwen3.8-27b",
  piModel: "", piModeFile: "",
};
let failures = 0;
const check = (name, ok, extra = "") => { console.log(`${ok ? "PASS" : "FAIL"}  ${name}${extra ? "  — " + extra : ""}`); if (!ok) failures++; };

const dir = "/tmp/eitest-r";
fs.rmSync(dir, { recursive: true, force: true });
fs.mkdirSync(dir, { recursive: true });
const f = path.join(dir, "tst.english");
// mirrors the user's real attempt: R stated in the preamble
fs.writeFileSync(f, `This file is an R script that does some data analytics.

To double some number:
    give back the number multiplied by 2

Make a vector called scores with the values 1, 4, and 9.
Print the result of doubling every value in scores.

For example, doubling 5 must give exactly 10.
`);

console.log("r: compiling…");
const r = await compile(f, fs.readFileSync(f, "utf8"), cfg, { translateMissing: true, lint: false, onProgress: m => console.log("  …", m) });
check("r: target inferred", r.target === "r", r.target);
check("r: shebang is Rscript", r.script.startsWith("#!/usr/bin/env Rscript"));
check("r: no python imports", !/\bimport\s+(pandas|sys)\b/.test(r.script), "");
check("r: no errors", !r.diagnostics.some(d => d.severity === "error"), JSON.stringify(r.diagnostics));
check("r: definition translated", /double\s*<-\s*function/.test(r.script) || /function\s*\(/.test(r.script), r.blocks[0]?.code?.split("\n")[0]);

const out = execFileSync("Rscript", ["-e", r.script], { timeout: 60000 }).toString();
check("r: program runs", /\b18\b/.test(out), out.trim().replace(/\n/g, " | ").slice(0, 100));

check("r: test script produced", !!r.testScript && /EI-TEST/.test(r.testScript));
const tout = execFileSync("Rscript", ["-e", r.testScript], { timeout: 60000 }).toString();
check("r: example passes", /EI-TEST \d+ PASS/.test(tout), tout.trim().split("\n").pop());

// locked build with a dead endpoint: proves no model calls are needed
const dead = { ...cfg, httpUrl: "http://127.0.0.1:1/v1/chat/completions" };
const locked = await compile(f, fs.readFileSync(f, "utf8"), dead, { translateMissing: false, locked: true });
check("r: locked build passes without a model", !locked.diagnostics.some(d => d.severity === "error"), JSON.stringify(locked.diagnostics));

console.log(failures ? `\n${failures} FAILURES` : "\nALL R TESTS PASS");
process.exit(failures ? 1 : 0);
