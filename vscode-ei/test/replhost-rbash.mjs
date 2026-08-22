// The R and bash ei hosts end to end: a stub raw-protocol server + the
// real host processes. Checks native passthrough, English translation with
// visible code, state persistence, blocks, continuation, and example checks.
import * as http from "node:http";
import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

let failures = 0;
const check = (name, ok, extra = "") => { console.log(`${ok ? "PASS" : "FAIL"}  ${name}${extra ? "  — " + extra : ""}`); if (!ok) failures++; };
const sleep = ms => new Promise(r => setTimeout(r, ms));

// stub server: canned translations over the plain-text raw protocol
const server = http.createServer((req, res) => {
  let body = "";
  req.on("data", d => body += d);
  req.on("end", () => {
    const t = body.trim();
    res.setHeader("Content-Type", "text/plain");
    if (req.headers["x-ei-token"] !== "t0k3n") { res.end("error\nbad token"); return; }
    let m;
    if ((m = t.match(/^add (\d+) and (\d+) into (\w+)$/))) {
      const code = req.url === "/translate-raw" && t.includes("into")
        ? (process.env.EI_TEST_TARGET === "r"
          ? `${m[3]} <- ${m[1]} + ${m[2]}`
          : `${m[3]}=$((${m[1]} + ${m[2]}))`)
        : "";
      res.end("ok\n" + code);
    } else if (/must give|example/.test(t)) {
      res.end("ok-example\n" + (process.env.EI_TEST_TARGET === "r"
        ? "stopifnot(2 + 2 == 4)"
        : "[ $((2 + 2)) -eq 4 ]"));
    } else if (/^greet everyone:/i.test(t)) {
      // a multi-line English block arrived as one unit
      res.end("ok\n" + (process.env.EI_TEST_TARGET === "r"
        ? `greet <- function() cat("hello block\\n")\ngreet()`
        : `greet() { echo "hello block"; }\ngreet`));
    } else {
      res.end("error\nno canned translation for: " + t);
    }
  });
});
await new Promise(r => server.listen(0, "127.0.0.1", r));
const port = /** @type {any} */ (server.address()).port;
const { R_REPL_HOST, BASH_REPL_HOST } = await import("../out/core/replHost.js");

async function drive(target, hostSrc, ext, shell, lines, preludeSrc) {
  process.env.EI_TEST_TARGET = target;
  const prelude = path.join(os.tmpdir(), `ei-test-prelude-${process.pid}.${ext}`);
  fs.writeFileSync(prelude, preludeSrc);
  const hostFile = path.join(os.tmpdir(), `ei-test-host-${process.pid}.${ext}`);
  fs.writeFileSync(hostFile, hostSrc);
  const child = spawn(shell, [hostFile], {
    env: { ...process.env, EI_REPL_PORT: String(port), EI_REPL_TOKEN: "t0k3n", EI_REPL_PRELUDE: prelude },
    stdio: ["pipe", "pipe", "pipe"],
  });
  let out = "";
  child.stdout.on("data", d => out += d);
  child.stderr.on("data", d => out += d);
  await sleep(700); // startup + prelude
  for (const l of lines) { child.stdin.write(l + "\n"); await sleep(450); }
  child.stdin.end();
  await new Promise(r => child.on("close", r));
  return out;
}

// ------------------------------------------------------------------ R
const rOut = await drive("r", R_REPL_HOST, "R", "Rscript", [
  "x <- 5",                       // plain R, silent
  "x * 2",                        // plain R, prints [1] 10
  "add 30 and 12 into res",       // english -> res <- 30 + 12
  "res",                          // state persists -> [1] 42
  "f <- function(a) {",           // incomplete R continues on ...
  "  a + 1",
  "}",
  "f(9)",                         // -> [1] 10
  "greet everyone:",              // english block
  "  say hello",
  "",                             // ends the block
  "four times four must give sixteen", // example check
], 'prelude_loaded <- TRUE\n');

check("R: banner", rOut.includes("English or R"));
check("R: prelude loaded", rOut.includes("libraries loaded"));
check("R: plain R prints visibly", rOut.includes("[1] 10"));
check("R: english echoes visible code", rOut.includes("\u27f6 res <- 30 + 12"));
check("R: state persists across lines", rOut.includes("[1] 42"));
check("R: incomplete R continues like +", (rOut.match(/\[1\] 10/g) ?? []).length >= 2);
check("R: english block collected", rOut.includes("hello block"));
check("R: example reports success", rOut.includes("\u2713 example holds"));
check("R: prompt returns", (rOut.match(/ei>/g) ?? []).length >= 5);

// --------------------------------------------------------------- bash
const bOut = await drive("bash", BASH_REPL_HOST, "sh", "bash", [
  "y=7",                          // plain bash assignment
  "echo $((y * 3))",              // plain bash -> 21
  "add 30 and 12 into res",       // english -> res=$((30 + 12))
  "echo $res",                    // state persists -> 42
  "greet everyone:",              // english block
  "  say hello",
  "",                             // ends the block
  "four times four must give sixteen", // example check
], 'prelude_var=ready\n');

check("bash: banner", bOut.includes("English or bash"));
check("bash: prelude loaded", bOut.includes("libraries loaded"));
check("bash: plain bash executes", bOut.includes("21"));
check("bash: english echoes visible code", bOut.includes("\u27f6 res=$((30 + 12))"));
check("bash: state persists across lines", bOut.includes("42"));
check("bash: english block collected", bOut.includes("hello block"));
check("bash: example reports success", bOut.includes("\u2713 example holds"));
check("bash: prompt returns", (bOut.match(/ei>/g) ?? []).length >= 4);

server.close();
console.log(failures ? `\n${failures} FAILURES` : "\nALL R/BASH HOST TESTS PASS");
process.exit(failures ? 1 : 0);
