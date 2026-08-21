#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { compile } from "./core/compiler";
import { instrument } from "./core/debug";
import { shutdownWarmPi } from "./core/engine";
import { EngineConfig } from "./core/types";

function usage(): never {
  console.error("usage: ei compile FILE.ei [-o OUT] | run FILE.ei | test FILE.ei | debug FILE.ei | lint FILE.ei | locked FILE.ei [-o OUT] | graph FILE.ei");
  process.exit(2);
}

function cfg(): EngineConfig {
  const root = path.resolve(__dirname, "..", "..");
  const mode = process.env.EI_MODE_FILE || path.join(root, "ei-mode.json");
  return {
    engine: process.env.EI_ENGINE === "pi" ? "pi" : "http",
    httpUrl: process.env.EI_URL || "http://192.168.2.24:8000/v1/chat/completions",
    httpApiKey: process.env.EI_KEY || "inktype-local",
    httpModel: process.env.EI_MODEL || "qwen/qwen3.8-27b",
    piModel: process.env.EI_PI_MODEL || "",
    piModeFile: fs.existsSync(mode) ? mode : "",
  };
}

function graphText(result: Awaited<ReturnType<typeof compile>>): string {
  const lines = [`target: ${result.target}`, `nodes: ${result.graph.nodes.length}`, ""];
  for (const n of result.graph.nodes) {
    lines.push(`[${n.id}] ${n.stmt.split("\n")[0]}`);
    lines.push(`  defines: ${n.facts.defines.join(", ") || "-"}`);
    lines.push(`  reads: ${n.facts.reads.join(", ") || "-"}`);
    lines.push(`  calls: ${n.facts.calls.join(", ") || "-"}`);
    lines.push(`  effects: ${n.facts.effects.join(", ") || "-"}`);
    lines.push(`  source: ${n.sourceHash}`);
    lines.push(`  interface: ${n.interfaceHash}`);
    lines.push(`  implementation: ${n.implementationHash}`);
    for (const d of n.dependencies) lines.push(`  depends on ${d.nodeId}${d.symbols.length ? ` (${d.symbols.join(", ")})` : ` (${d.kind})`}`);
    lines.push("");
  }
  return lines.join("\n");
}

// Programs run with their source directory as the working directory, so
// relative paths in the prose ("./expenses.csv") mean what the reader thinks.
function runScript(target: "bash" | "python", script: string, cwd: string): number {
  const tmp = path.join(os.tmpdir(), `ei-run-${process.pid}-${Date.now()}${target === "python" ? ".py" : ".sh"}`);
  fs.writeFileSync(tmp, script, { mode: 0o755 });
  const run = spawnSync(target === "python" ? "python3" : "bash", [tmp], { stdio: "inherit", cwd });
  try { fs.unlinkSync(tmp); } catch {}
  return run.status ?? 1;
}

async function main() {
  const [cmd, file, ...rest] = process.argv.slice(2);
  if (!cmd || !file || !["compile", "run", "test", "debug", "lint", "locked", "graph"].includes(cmd)) usage();
  if (!fs.existsSync(file)) { console.error(`ei: no such file: ${file}`); process.exit(2); }
  const full = path.resolve(file), text = fs.readFileSync(full, "utf8");
  const locked = cmd === "locked";
  const result = await compile(full, text, cfg(), {
    translateMissing: !locked,
    locked,
    pinByDefault: process.env.EI_PIN_BY_DEFAULT !== "0",
    lint: process.env.EI_LINT !== "0",
    onProgress: msg => console.error(`ei: ${msg}`),
  });
  for (const d of result.diagnostics) console.error(`ei: ${d.severity}: ${full}:${d.line + 1}: ${d.message}`);
  if (cmd === "lint") {
    const warnings = result.diagnostics.filter(d => d.code === "ambiguity");
    console.error(`ei: ${warnings.length} ambiguity warning(s)`);
    process.exit(result.diagnostics.some(d => d.severity === "error") ? 1 : 0);
  }
  if (result.diagnostics.some(d => d.severity === "error")) process.exit(1);

  if (cmd === "graph") { process.stdout.write(graphText(result)); return; }
  const cwd = path.dirname(full);
  if (cmd === "run") process.exit(runScript(result.target, result.script, cwd));
  if (cmd === "debug") process.exit(runScript(result.target, instrument(result), cwd));
  if (cmd === "test") {
    if (!result.testScript) { console.error("ei: this program states no examples to test."); process.exit(0); }
    console.error(`ei: running ${result.exampleBlocks.length} example check(s)`);
    process.exit(runScript(result.target, result.testScript, cwd));
  }
  let out = "";
  const oi = rest.indexOf("-o");
  if (oi >= 0 && rest[oi + 1]) out = rest[oi + 1];
  if (out) {
    fs.writeFileSync(out, result.script, { mode: 0o755 });
    console.error(`ei: wrote ${out}${locked ? " (locked; no model calls)" : ""}`);
  } else process.stdout.write(result.script.endsWith("\n") ? result.script : result.script + "\n");
}

main()
  .catch(error => { console.error(`ei: ${error instanceof Error ? error.message : String(error)}`); process.exitCode = 1; })
  .finally(() => shutdownWarmPi());
