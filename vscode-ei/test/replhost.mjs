// The ei REPL host end to end: a stub translation server + the real host
// process. Checks python passthrough, English translation with visible code,
// blocks, and example checks.
import * as http from "node:http";
import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

let failures = 0;
const check = (name, ok, extra = "") => { console.log(`${ok ? "PASS" : "FAIL"}  ${name}${extra ? "  — " + extra : ""}`); if (!ok) failures++; };

// stub server: canned translations like the extension would produce
const server = http.createServer((req, res) => {
  let body = "";
  req.on("data", d => body += d);
  req.on("end", () => {
    const { text } = JSON.parse(body);
    const t = text.trim();
    let out;
    if (/^add \d+ and \d+$/.test(t)) {
      const [a, b] = t.match(/\d+/g).map(Number);
      out = { code: `print(${a} + ${b})` };
    } else if (t.includes("must give")) {
      out = { code: `assert 2 + 2 == 4`, kind: "example" };
    } else {
      out = { error: `no canned translation for: ${t}` };
    }
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify(out));
  });
});
await new Promise(r => server.listen(0, "127.0.0.1", r));
const port = /** @type {any} */ (server.address()).port;

// prelude that must run at startup
const prelude = path.join(os.tmpdir(), `ei-test-prelude-${process.pid}.py`);
fs.writeFileSync(prelude, "prelude_loaded = True\n");

const hostFile = path.join(os.tmpdir(), `ei-test-host-${process.pid}.py`);
// the embedded host source ships in the TS output
const { PY_REPL_HOST } = await import("../out/core/replHost.js");
fs.writeFileSync(hostFile, PY_REPL_HOST);

const child = spawn("python3", [hostFile], {
  env: { ...process.env, EI_REPL_PORT: String(port), EI_REPL_TOKEN: "t0k3n", EI_REPL_PRELUDE: prelude },
  stdio: ["pipe", "pipe", "pipe"],
});
let out = "";
child.stdout.on("data", d => out += d);
child.stderr.on("data", d => out += d);

child.stdin.write("x = 5\n");                       // plain python
await sleep(300);
child.stdin.write("add 23 and 19\n");               // english -> print(23 + 19)
await sleep(400);
child.stdin.write("for i in range(2):\n");          // block start
await sleep(150);
child.stdin.write(`    print("i is", i)\n`);        // body line
await sleep(150);
child.stdin.write("\n");                            // ends the block
await sleep(400);
child.stdin.write("four times four must give sixteen\n"); // example check
await sleep(500);
child.stdin.end(); // EOF exits the host
await new Promise(r => child.on("close", r));
server.close();

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

check("host: banner", out.includes("English or Python"));
check("host: libraries loaded from prelude", out.includes("libraries loaded"), "");
check("host: plain python executes silently", out.includes("ei>") && !out.includes("Traceback"), "");
check("host: english echoes visible code", out.includes("\u27f6 print(23 + 19)"));
check("host: english executed", out.includes("42"));
check("host: block collected and executed", out.includes("i is 0") && out.includes("i is 1"));
check("host: example reports success", out.includes("\u2713 example holds"));
check("host: prompt returns after each line", (out.match(/ei>/g) ?? []).length >= 4);

console.log(failures ? `\n${failures} FAILURES` : "\nALL REPL-HOST TESTS PASS");
process.exit(failures ? 1 : 0);
