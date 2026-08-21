// REPL core: JIT translation + persistent state in a real python3 -i process.
import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { replSetup, replTranslate } from "../out/core/compiler.js";

const cfg = {
  engine: "http",
  httpUrl: "http://192.168.2.24:8000/v1/chat/completions",
  httpApiKey: "inktype-local",
  httpModel: "qwen/qwen3.8-27b",
  piModel: "", piModeFile: "",
};
let failures = 0;
const check = (name, ok, extra = "") => { console.log(`${ok ? "PASS" : "FAIL"}  ${name}${extra ? "  — " + extra : ""}`); if (!ok) failures++; };

const dir = "/tmp/eitest-repl";
fs.rmSync(dir, { recursive: true, force: true });
fs.mkdirSync(dir, { recursive: true });
const f = path.join(dir, "session.ei");
fs.writeFileSync(f, `This interactive session is in Python.

Set the price to 100.
Add 20 percent tax to the price and store it as the total.
Show the total.
`);

console.log("repl: setup…");
const session = await replSetup(f, fs.readFileSync(f, "utf8"), cfg, m => console.log("  …", m));
check("repl: target inferred", session.target === "python");

const statements = [
  "Set the price to 100.",
  "Add 20 percent tax to the price and store it as the total.",
  "Show the total.",
];
let sessionCode = "";
const blocks = [];
for (const stmt of statements) {
  const r = await replTranslate(f, stmt, session, sessionCode, cfg);
  console.log(`  ${stmt} ⟶ ${r.code.split("\n")[0]}`);
  blocks.push(r.code);
  sessionCode += r.code.endsWith("\n") ? r.code : r.code + "\n";
}
check("repl: three translations", blocks.length === 3 && blocks.every(b => b.trim()));

// replay: every statement must now come from cache (JIT warm path)
let cached = 0;
sessionCode = "";
for (const stmt of statements) {
  const r = await replTranslate(f, stmt, session, sessionCode, cfg);
  if (r.fromCache) cached++;
  sessionCode += r.code.endsWith("\n") ? r.code : r.code + "\n";
}
check("repl: replay is fully cached", cached === 3, `${cached}/3`);

// run the blocks through a REAL python3 -i process with the exec-file flow
// the extension uses; state must persist between blocks.
const blockFile = path.join(dir, "block.py");
const py = spawn("python3", ["-q", "-i"], { stdio: ["pipe", "pipe", "pipe"] });
let out = "";
py.stdout.on("data", d => out += d);
py.stderr.on("data", d => out += d);
for (const code of blocks) {
  fs.writeFileSync(blockFile, code + "\n");
  py.stdin.write(`exec(open(${JSON.stringify(blockFile)}).read())\n`);
  await new Promise(r => setTimeout(r, 300));
}
py.stdin.end();
await new Promise(r => py.on("close", r));
check("repl: state persists across statements", out.includes("120"), out.replace(/\n/g, " | ").slice(0, 120));

console.log(failures ? `\n${failures} FAILURES` : "\nALL REPL TESTS PASS");
process.exit(failures ? 1 : 0);
