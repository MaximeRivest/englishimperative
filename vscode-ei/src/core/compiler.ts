import { execFile } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { briefFor, cachedBriefText, expandHome, preludeFor } from "./briefs";
import { loadCache, saveCache, sha, stmtKey } from "./cache";
import { engineId, llm } from "./engine";
import { englishNameOfCode, isSourceFile, languageOfFile, stripSourceExt } from "./language";
import { clampPreamble, parse } from "./parser";
import {
  assignNodeIds, buildDependencyGraph, changedDependencies, dependencyMap,
  transitiveDependents,
} from "./semantic";
import {
  BlockResult, CacheData, CompileResult, DependencyGraph, Diag, EngineConfig,
  GraphNode, ModuleInfo, StalenessInfo, Survey, Unit,
} from "./types";

const SURVEY_SYS = `You analyze a natural-language program. The program may be written in any human language (English, French, Spanish, Chinese, …). Input lines are numbered "N: text".
Output ONLY one JSON object, no fences, no prose:
{"language":"iso-639-1","target":"bash"|"python","preamble_end_line":N,"uses":["path",...],"definitions":[{"line":N,"name":"snake_case_name"},...],"examples":[{"line":N,"name":"short_test_name"},...]}
language: the ISO 639-1 code of the human language of the source text.
target: the language the text states or implies; default bash.
preamble_end_line: last line of an opening description that only introduces the program (0 if the file starts with instructions).
uses: local files, directories, or repos the program says it depends on, exactly as written.
definitions: top-level statements that define a reusable procedure, in any wording, with the line number of their first line and a good target-language function name.
examples: top-level statements that assert a specific expected outcome to verify (a worked example, an expectation, a must-give claim), in any wording. A statement that merely performs an action (print, read, compute, save) is a program step, never an example. When in doubt, it is a program step.
The author never uses reserved words; read intent from meaning and structure, not from specific vocabulary.`;

const LINT_SYS = `You review a natural-language program for ambiguity before translation to code. The program may be written in any human language; answer in the language of the source. Input lines are numbered "N: text".
Output ONLY a JSON array, no fences, no prose: [{"line":N,"message":"..."},...]
Report only problems that could change the generated code: a pronoun with no clear antecedent, a value with no unit or format, an ambiguous order of steps, an unclear scope ("the file" when several exist), or a quantity like "a few".
Do not report style. Do not report clear statements. An empty array is a good answer.
The author never uses reserved words; judge meaning, not vocabulary.`;

function exampleSys(target: string, briefs: string, outline: string, srcLang: string): string {
  let sys = `You are a strict natural-language-to-${target} test writer. The source is written in ${srcLang}. The user's statement states an expected result, in any wording. Translate it into ${target} code that CHECKS the expectation against the program state shown in the context: compute the actual value and ${target === "python" ? "use assert (with a clear message) or raise AssertionError" : "compare it and exit 1 with an error message on mismatch"}. Output ONLY the checking code: no fences, no comments, no prose. Do not print on success.`;
  if (outline) sys += ` Functions defined in this program: ${outline}.`;
  if (briefs) sys += `\n\nKnown libraries (API reference):\n${briefs}`;
  return sys;
}

function translateSys(target: string, briefs: string, outline: string, srcLang: string): string {
  let sys = `You are a strict natural-language-to-${target} interpreter. The source is written in ${srcLang}. Translate the user's statement into ${target} code. Identifiers you invent should be in English; string literals and printed text keep the source language. Output ONLY the code: no markdown fences, no comments, no explanation. The code is appended to the script shown in the context, so build on its state (variables, imports, directory). Use only names that are in scope at the point where your code is appended; a variable local to a function does not exist at top level. The statement may be a block: a header line that ends with a colon, with an indented body. A body may contain a decision table (rows with |): translate it into the equivalent conditional logic. The user may phrase anything in any words: interpret intent, never require specific vocabulary. Prose that defines a reusable procedure, however it is worded, becomes a function; any phrase that means returning a value becomes a return.`;
  if (outline) sys += ` Functions defined in this program: ${outline}. When a statement refers to one of them, emit a call to it by that name.`;
  if (briefs) sys += ` The script so far already loads the libraries below; call their functions through the module name. If a value from an earlier statement is needed but was not stored in a variable, recompute it.\n\nKnown libraries (API reference):\n${briefs}`;
  return sys;
}

export async function runSurvey(text: string, cfg: EngineConfig): Promise<Survey> {
  const numbered = text.split(/\r?\n/).map((l, i) => `${i + 1}: ${l}`).join("\n");
  const fallback: Survey = { target: "bash", preambleEnd: 0, uses: [], definitions: [], examples: [], language: undefined };
  let out = "";
  try { out = await llm(SURVEY_SYS, numbered, 500, cfg); } catch { return fallback; }
  let raw: any;
  try { raw = JSON.parse(out); } catch { return fallback; }
  if (!raw || typeof raw !== "object") return fallback;
  const survey: Survey = {
    language: typeof raw.language === "string" ? englishNameOfCode(raw.language) ?? undefined : undefined,
    target: raw.target === "python" ? "python" : "bash",
    preambleEnd: Number.isInteger(raw.preamble_end_line) && raw.preamble_end_line > 0 ? raw.preamble_end_line : 0,
    uses: Array.isArray(raw.uses) ? raw.uses.filter((u: any) => typeof u === "string") : [],
    definitions: Array.isArray(raw.definitions)
      ? raw.definitions.filter((d: any) => d && Number.isInteger(d.line) && typeof d.name === "string")
          .map((d: any) => ({ line: d.line, name: d.name }))
      : [],
    examples: Array.isArray(raw.examples)
      ? raw.examples.filter((d: any) => d && Number.isInteger(d.line) && typeof d.name === "string")
          .map((d: any) => ({ line: d.line, name: d.name }))
      : [],
  };
  survey.preambleEnd = clampPreamble(text, survey.preambleEnd);
  // a statement cannot be both a definition and an example
  const defLines = new Set(survey.definitions.map(d => d.line));
  survey.examples = survey.examples.filter(e => !defLines.has(e.line));
  return survey;
}

export async function runLint(text: string, cfg: EngineConfig): Promise<{ line: number; endLine: number; message: string }[]> {
  const numbered = text.split(/\r?\n/).map((l, i) => `${i + 1}: ${l}`).join("\n");
  let out = "";
  try { out = await llm(LINT_SYS, numbered, 700, cfg); } catch { return []; }
  try {
    const raw = JSON.parse(out);
    if (!Array.isArray(raw)) return [];
    return raw.filter((w: any) => w && Number.isInteger(w.line) && typeof w.message === "string")
      .map((w: any) => ({ line: w.line - 1, endLine: w.line - 1, message: w.message }));
  } catch { return []; }
}

function surveyKey(text: string, cfg: EngineConfig): string {
  return sha(engineId(cfg) + "\u0000" + text).slice(0, 24);
}

export async function surveyCached(eiFile: string, text: string, cfg: EngineConfig, cache: CacheData): Promise<Survey> {
  const key = surveyKey(text, cfg);
  if (cache.survey?.key === key) return cache.survey.value;
  const value = await runSurvey(text, cfg);
  cache.survey = { key, value };
  return value;
}

interface OrderedUnit { unit: Unit; hoisted: boolean }

function orderUnits(units: Unit[], survey: Survey): OrderedUnit[] {
  const defLines = new Set(survey.definitions.map(d => d.line - 1));
  const kept = units.filter(u => u.startLine >= survey.preambleEnd);
  const hoisted = kept.filter(u => u.kind === "statement" && defLines.has(u.startLine));
  const rest = kept.filter(u => !hoisted.includes(u));
  return [...hoisted.map(unit => ({ unit, hoisted: true })), ...rest.map(unit => ({ unit, hoisted: false }))];
}

function translationKey(cfg: EngineConfig, target: string, briefsHash: string, context: string, stmt: string): string {
  return sha([engineId(cfg), target, briefsHash, context, stmt.trim()].join("\u0000")).slice(0, 32);
}

function commentize(stmt: string): string {
  return stmt.split("\n").map(l => `# ${l}`).join("\n");
}

async function syntaxCheck(target: "bash" | "python", script: string): Promise<{ message: string; line: number } | null> {
  const tmp = path.join(os.tmpdir(), `ei-vsc-${process.pid}-${Date.now()}`);
  fs.writeFileSync(tmp, script);
  try {
    const run = (cmd: string, args: string[]) => new Promise<{ code: number; stderr: string }>(resolve => {
      execFile(cmd, args, { timeout: 20000 }, (err, _stdout, stderr) => resolve({ code: err ? 1 : 0, stderr: String(stderr ?? (err ? String(err) : "")) }));
    });
    if (target === "python") {
      const r = await run("python3", ["-c", `import ast,sys\ntry:\n ast.parse(open(sys.argv[1]).read())\nexcept SyntaxError as e:\n print(f"line {e.lineno}: {e.msg}", file=sys.stderr)\n sys.exit(1)`, tmp]);
      if (r.code !== 0) {
        const m = /line (\d+): (.*)/.exec(r.stderr);
        return { line: m ? parseInt(m[1], 10) - 1 : 0, message: m ? m[2] : r.stderr.trim() || "syntax error" };
      }
    } else {
      const r = await run("bash", ["-n", tmp]);
      if (r.code !== 0) {
        const m = /line (\d+): (.*)/.exec(r.stderr);
        return { line: m ? parseInt(m[1], 10) - 1 : 0, message: m ? m[2] : r.stderr.trim() || "syntax error" };
      }
    }
    return null;
  } finally { try { fs.unlinkSync(tmp); } catch {} }
}

export interface CompileOptions {
  translateMissing: boolean;
  force?: Set<string>;
  pinByDefault?: boolean;
  locked?: boolean;
  lint?: boolean;
  moduleStack?: string[]; // internal: cycle detection for .ei modules
  round?: number;         // internal: auto-repin fixed-point counter
  onProgress?: (msg: string) => void;
  token?: { isCancellationRequested: boolean };
}

// "uses" paths in prose resolve like a reader would resolve them: absolute
// and ~ paths as written, relative paths from the program's own directory.
export function resolveUsePath(eiFile: string, use: string): string {
  const e = expandHome(use.trim());
  return path.isAbsolute(e) ? e : path.resolve(path.dirname(eiFile), e);
}

function moduleName(file: string): string {
  const base = path.basename(stripSourceExt(file)).replace(/[^A-Za-z0-9_]/g, "_");
  return /^[A-Za-z_]/.test(base) ? base : "m_" + base;
}

// Shared by compile() and the REPL: briefs, deterministic prelude, and
// compiled English modules for everything the prose says it uses.
async function resolveUses(
  eiFile: string, survey: Survey, target: "bash" | "python", cfg: EngineConfig,
  opts: CompileOptions, diagnostics: Diag[], locked: boolean,
): Promise<{ briefs: string; prelude: string; modules: ModuleInfo[] }> {
  let briefs = "", prelude = "";
  const modules: ModuleInfo[] = [];
  if (survey.uses.length) {
    if (target === "python") prelude = "import sys\n";
    for (const rawUse of survey.uses) {
      const u = resolveUsePath(eiFile, rawUse);
      if (isSourceFile(u)) {
        opts.onProgress?.(`module: ${rawUse}`);
        // this file joins the stack so that a → b → a is a cycle
        let self = eiFile; try { self = fs.realpathSync(eiFile); } catch {}
        const modOpts = { ...opts, moduleStack: [...(opts.moduleStack ?? []), self] };
        const mod = await compileModule(u, target, cfg, modOpts, diagnostics, survey.preambleEnd);
        if (!mod) continue;
        modules.push(mod);
        briefs += "\n" + mod.brief + "\n";
        prelude += target === "python"
          ? `sys.path.insert(0, '${path.dirname(mod.artifact)}')\nimport ${mod.name}\n`
          : `source '${mod.artifact}'\n`;
        continue;
      }
      opts.onProgress?.(`library: ${rawUse}`);
      const brief = locked ? cachedBriefText(u) : await briefFor(u, cfg);
      if (locked && !brief) diagnostics.push({ line: 0, endLine: Math.max(0, survey.preambleEnd - 1), message: `Locked build cannot continue: the cached library brief is missing or stale: ${rawUse}`, severity: "error", code: "locked-brief" });
      briefs += "\n" + brief + "\n";
      prelude += preludeFor(target, u);
    }
    if (prelude) prelude = "# libraries\n" + prelude + "\n";
  }
  return { briefs, prelude, modules };
}

// An .ei dependency is an English module: compile it first (its own sidecar
// and pins), write its artifact, and describe its public API in English.
async function compileModule(
  rawPath: string, parentTarget: "bash" | "python", cfg: EngineConfig, opts: CompileOptions,
  diagnostics: Diag[], preambleEnd: number,
): Promise<ModuleInfo | null> {
  const diagLine = { line: 0, endLine: Math.max(0, preambleEnd - 1) };
  const p = expandHome(rawPath);
  if (!fs.existsSync(p)) { diagnostics.push({ ...diagLine, message: `English module not found: ${rawPath}`, severity: "error", code: "module" }); return null; }
  const resolved = fs.realpathSync(p);
  const stack = opts.moduleStack ?? [];
  if (stack.includes(resolved)) {
    diagnostics.push({ ...diagLine, message: `Module cycle: ${[...stack, resolved].map(f => path.basename(f)).join(" → ")}`, severity: "error", code: "module-cycle" });
    return null;
  }
  if (stack.length >= 8) { diagnostics.push({ ...diagLine, message: "Module depth limit (8) reached.", severity: "error", code: "module" }); return null; }
  const sub = await compile(resolved, fs.readFileSync(resolved, "utf8"), cfg, {
    translateMissing: opts.translateMissing,
    locked: opts.locked,
    pinByDefault: opts.pinByDefault,
    lint: false,
    moduleStack: [...stack, resolved],
    token: opts.token,
    onProgress: m => opts.onProgress?.(`${path.basename(resolved)}: ${m}`),
  });
  const errors = sub.diagnostics.filter(d => d.severity === "error");
  if (errors.length) {
    const cycle = errors.find(e => e.code === "module-cycle");
    diagnostics.push({ ...diagLine, message: `English module ${path.basename(resolved)} failed: ${(cycle ?? errors[0]).message}${errors.length > 1 ? ` (+${errors.length - 1} more)` : ""}`, severity: "error", code: cycle ? "module-cycle" : "module" });
    return null;
  }
  if (sub.target !== parentTarget) {
    diagnostics.push({ ...diagLine, message: `English module ${path.basename(resolved)} targets ${sub.target}; this program targets ${parentTarget}. Cross-language modules are not supported yet.`, severity: "error", code: "module" });
    return null;
  }
  const name = moduleName(resolved);
  // generated code lives in .ei-build/, never beside the human-authored prose
  const buildDir = path.join(path.dirname(resolved), ".ei-build");
  const artifact = path.join(buildDir, name + (sub.target === "python" ? ".py" : ".sh"));
  try {
    fs.mkdirSync(buildDir, { recursive: true });
    if (!fs.existsSync(artifact) || fs.readFileSync(artifact, "utf8") !== sub.script) fs.writeFileSync(artifact, sub.script, { mode: 0o755 });
  } catch (e: any) {
    diagnostics.push({ ...diagLine, message: `cannot write module artifact ${artifact}: ${e?.message ?? e}`, severity: "error", code: "module" });
    return null;
  }
  const lines = [`## English module ${name} (from ${path.basename(resolved)}) provides:`];
  for (const node of sub.graph.nodes) {
    for (const f of node.facts.functions ?? []) {
      lines.push(`- ${name}.${f.name}(${f.parameters.join(", ")}) — "${node.stmt.split("\n")[0].slice(0, 90)}"`);
    }
  }
  if (lines.length === 1) lines.push(`- (no public functions; importing it runs its top-level statements)`);
  return { path: resolved, name, artifact, target: sub.target, brief: lines.join("\n") };
}

function cachedSurveyForLocked(text: string, cfg: EngineConfig, cache: CacheData, diagnostics: Diag[]): Survey {
  const expected = surveyKey(text, cfg);
  if (!cache.survey || cache.survey.key !== expected) {
    diagnostics.push({ line: 0, endLine: 0, message: "Locked build cannot continue: the program survey is missing or stale. Run a development compile first.", severity: "error", code: "locked-survey" });
  }
  return cache.survey?.value ?? { target: "bash", preambleEnd: 0, uses: [], definitions: [], examples: [] };
}

export async function compile(eiFile: string, text: string, cfg: EngineConfig, opts: CompileOptions): Promise<CompileResult> {
  const cache = loadCache(eiFile);
  const previousGraph = cache.graph;
  const parsed = parse(text);
  const diagnostics: Diag[] = [];
  const locked = !!opts.locked;
  const pinByDefault = opts.pinByDefault !== false;

  opts.onProgress?.(locked ? "checking locked program…" : "surveying program…");
  const survey = locked
    ? cachedSurveyForLocked(text, cfg, cache, diagnostics)
    : opts.translateMissing ? await surveyCached(eiFile, text, cfg, cache)
    : (cache.survey?.value ?? { target: "bash", preambleEnd: 0, uses: [], definitions: [], examples: [] });

  // sidecars written by older versions may miss newer survey fields
  (survey as any).examples ??= [];
  (survey as any).uses ??= [];
  (survey as any).definitions ??= [];

  const target = (parsed.explicitTarget === "python" || parsed.explicitTarget === "bash")
    ? parsed.explicitTarget as "bash" | "python" : survey.target;

  const { briefs, prelude, modules } = await resolveUses(eiFile, survey, target, cfg, opts, diagnostics, locked);

  // ambiguity linter: one cached model pass, development builds only
  if (opts.lint !== false && opts.translateMissing && !locked) {
    const lintKey = surveyKey(text, cfg);
    if (!cache.lint || cache.lint.key !== lintKey) {
      opts.onProgress?.("linting for ambiguity…");
      cache.lint = { key: lintKey, value: await runLint(text, cfg) };
    }
    for (const w of cache.lint.value) diagnostics.push({ line: w.line, endLine: w.endLine, message: `ambiguity: ${w.message}`, severity: "warning", code: "ambiguity" });
  } else if (cache.lint?.key === surveyKey(text, cfg)) {
    for (const w of cache.lint.value) diagnostics.push({ line: w.line, endLine: w.endLine, message: `ambiguity: ${w.message}`, severity: "warning", code: "ambiguity" });
  }
  const briefsHash = sha(briefs).slice(0, 16);
  const outline = survey.definitions.map(d => d.name).join(", ");
  const srcLang = languageOfFile(eiFile) ?? survey.language ?? "a human language (detect it from the text)";
  const sys = translateSys(target, briefs, outline, srcLang);
  const exampleLines = new Set(survey.examples.map(e => e.line - 1));
  const exampleName = new Map(survey.examples.map(e => [e.line - 1, e.name]));
  const ordered = orderUnits(parsed.units, survey).filter(o => !(o.unit.kind === "statement" && exampleLines.has(o.unit.startLine)));
  const exampleUnits = parsed.units.filter(u => u.kind === "statement" && exampleLines.has(u.startLine));
  const sourceStatements = parsed.units.filter(u => u.kind === "statement" && u.startLine >= survey.preambleEnd);
  const nodeIds = assignNodeIds(sourceStatements, previousGraph);
  const idByUnit = new Map<Unit, string>(sourceStatements.map((u, i) => [u, nodeIds[i]]));
  const oldById = new Map((previousGraph?.nodes ?? []).map(n => [n.id, n]));

  const blocks: BlockResult[] = [];
  let code = prelude;
  let mutated = false;
  const repin = new Set<string>();

  for (const { unit } of ordered) {
    if (opts.token?.isCancellationRequested) break;
    if (unit.kind === "comment") { code += unit.text + "\n"; continue; }
    const sKey = stmtKey(unit.text);
    const nodeId = idByUnit.get(unit) ?? `unknown-${unit.startLine}`;
    const existingPin = cache.pins[sKey];
    const forced = !!opts.force?.has(sKey);
    let blockCode = "", pinned = false, automaticPin = false, fromCache = false, error: string | undefined;

    if (existingPin && !forced) {
      blockCode = existingPin.code;
      pinned = true;
      automaticPin = !!existingPin.automatic;
    } else if (locked) {
      error = "no pinned translation";
      diagnostics.push({ line: unit.startLine, endLine: unit.endLine, message: "Locked build cannot continue: this statement has no matching pin. Run a development compile first.", severity: "error", code: "locked-pin" });
    } else {
      // AST dependency state replaces the old all-previous-code invalidation
      // when a previous semantic node exists. New nodes use full context once.
      const oldNode = oldById.get(nodeId);
      const contextKey = oldNode ? `deps:${oldNode.dependencyInterfaceHash}` : `initial:${sha(code).slice(0, 24)}`;
      const tKey = translationKey(cfg, target, briefsHash, contextKey, unit.text);
      const hit = forced ? undefined : cache.translations[tKey];
      if (hit) { blockCode = hit.code; fromCache = true; }
      else if (opts.translateMissing) {
        opts.onProgress?.(unit.text.split("\n")[0]);
        try {
          const user = `Script so far:\n${code}\n\nStatement to translate: ${unit.text}`;
          blockCode = await llm(sys, user, 800, cfg);
          if (!blockCode.trim()) throw new Error("empty translation");
          cache.translations[tKey] = { code: blockCode, stmt: unit.text, at: Date.now() };
          mutated = true;
        } catch (e: any) {
          error = String(e?.message ?? e);
          diagnostics.push({ line: unit.startLine, endLine: unit.endLine, message: `translation failed: ${error}`, severity: "error", code: "translation" });
        }
      } else error = "not translated yet";

      if (blockCode && (pinByDefault || existingPin)) {
        cache.pins[sKey] = {
          code: blockCode, stmt: unit.text, at: Date.now(),
          automatic: existingPin ? !!existingPin.automatic : pinByDefault,
        };
        pinned = true;
        automaticPin = !!cache.pins[sKey].automatic;
        repin.add(sKey);
        mutated = true;
      }
    }

    const lineCount = (s: string) => s === "" ? 0 : s.split("\n").length - (s.endsWith("\n") ? 1 : 0);
    const blockText = `${commentize(unit.text)}\n${blockCode || "# (untranslated)"}\n\n`;
    const genStart = lineCount(code);
    code += blockText;
    const genEnd = lineCount(code) - 2;
    blocks.push({ unit, nodeId, code: blockCode, pinned, automaticPin, fromCache, error, genStart, genEnd });
  }

  const shebang = target === "python" ? "#!/usr/bin/env python3" : "#!/usr/bin/env bash";
  const preambleLines = text.split(/\r?\n/).slice(0, survey.preambleEnd);
  const pre = preambleLines.length ? preambleLines.map(l => `# ${l}`).join("\n") + "\n\n" : "";
  const headerText = `${shebang}\n# generated by ei from ${path.basename(eiFile)}\n\n${pre}`;
  const headerLen = headerText.split("\n").length - 1;
  for (const b of blocks) { b.genStart += headerLen; b.genEnd += headerLen; }
  const script = headerText + code;

  // ------------------------------------------------ examples → test script
  const exampleBlocks: BlockResult[] = [];
  let testScript = "";
  if (exampleUnits.length) {
    const esys = exampleSys(target, briefs, outline, srcLang);
    const lineCount = (s: string) => s === "" ? 0 : s.split("\n").length - (s.endsWith("\n") ? 1 : 0);
    const indent = (s: string) => s.split("\n").map(l => l ? "    " + l : l).join("\n");
    let test = target === "python" ? "# ei examples (tests)\n__ei_failures = 0\n\n" : "# ei examples (tests)\n__ei_failures=0\n\n";
    for (const unit of exampleUnits) {
      if (opts.token?.isCancellationRequested) break;
      const sKey = stmtKey(unit.text);
      const nodeId = idByUnit.get(unit) ?? `unknown-${unit.startLine}`;
      const name = (exampleName.get(unit.startLine) ?? "example").replace(/[^A-Za-z0-9_-]/g, "_");
      const existingPin = cache.pins[sKey];
      const forced = !!opts.force?.has(sKey);
      let blockCode = "", pinned = false, automaticPin = false, fromCache = false, error: string | undefined;
      if (existingPin && !forced) { blockCode = existingPin.code; pinned = true; automaticPin = !!existingPin.automatic; }
      else if (locked) {
        error = "no pinned translation";
        diagnostics.push({ line: unit.startLine, endLine: unit.endLine, message: "Locked build cannot continue: this example has no matching pin.", severity: "error", code: "locked-pin" });
      } else {
        const oldNode = oldById.get(nodeId);
        const contextKey = oldNode ? `ex-deps:${oldNode.dependencyInterfaceHash}` : `ex-initial:${sha(code).slice(0, 24)}`;
        const tKey = translationKey(cfg, target, briefsHash, contextKey, unit.text);
        const hit = forced ? undefined : cache.translations[tKey];
        if (hit) { blockCode = hit.code; fromCache = true; }
        else if (opts.translateMissing) {
          opts.onProgress?.(`example: ${unit.text.split("\n")[0]}`);
          try {
            const user = `Program:\n${code}\n\nExpectation to check: ${unit.text}`;
            blockCode = await llm(esys, user, 800, cfg);
            if (!blockCode.trim()) throw new Error("empty translation");
            cache.translations[tKey] = { code: blockCode, stmt: unit.text, at: Date.now() };
            mutated = true;
          } catch (e: any) {
            error = String(e?.message ?? e);
            diagnostics.push({ line: unit.startLine, endLine: unit.endLine, message: `example translation failed: ${error}`, severity: "error", code: "translation" });
          }
        } else error = "not translated yet";
        if (blockCode && (pinByDefault || existingPin)) {
          cache.pins[sKey] = { code: blockCode, stmt: unit.text, at: Date.now(), automatic: existingPin ? !!existingPin.automatic : pinByDefault };
          pinned = true; automaticPin = !!cache.pins[sKey].automatic; repin.add(sKey); mutated = true;
        }
      }
      const src = unit.startLine + 1;
      const wrapped = target === "python"
        ? `${commentize(unit.text)}\ntry:\n${indent(blockCode || "raise AssertionError('untranslated example')")}\n    print("EI-TEST ${src} PASS ${name}")\nexcept Exception as __ei_e:\n    print(f"EI-TEST ${src} FAIL ${name}: {__ei_e}")\n    __ei_failures += 1\n\n`
        : `${commentize(unit.text)}\nif (\n  set -e\n${(blockCode || "false").split("\n").map(l => "  " + l).join("\n")}\n); then echo "EI-TEST ${src} PASS ${name}"; else echo "EI-TEST ${src} FAIL ${name}"; __ei_failures=$((__ei_failures+1)); fi\n\n`;
      const genStart = lineCount(script) + lineCount(test);
      test += wrapped;
      const genEnd = lineCount(script) + lineCount(test) - 2;
      exampleBlocks.push({ unit, nodeId, isExample: true, code: blockCode, pinned, automaticPin, fromCache, error, genStart, genEnd });
    }
    test += target === "python"
      ? `import sys as __ei_sys\n__ei_sys.exit(1 if __ei_failures else 0)\n`
      : `exit $(( __ei_failures > 0 ))\n`;
    testScript = script + test;
  }

  opts.onProgress?.("analyzing dependencies…");
  const blockById = new Map([...blocks, ...exampleBlocks].map(b => [b.nodeId, b]));
  const graph = await buildDependencyGraph(target, engineId(cfg), briefsHash, text,
    sourceStatements.map((unit, ordinal) => ({ unit, ordinal, nodeId: nodeIds[ordinal], code: blockById.get(nodeIds[ordinal])?.code ?? "" })));
  const graphById = new Map(graph.nodes.map(n => [n.id, n]));

  // Add semantic facts and pin-dependency checks to source mappings.
  for (const block of [...blocks, ...exampleBlocks]) {
    const node = graphById.get(block.nodeId);
    if (!node) continue;
    block.facts = node.facts;
    block.dependencies = node.dependencies;
    block.sourceHash = node.sourceHash;
    block.implementationHash = node.implementationHash;
    block.interfaceHash = node.interfaceHash;
    const pin = cache.pins[node.stmtKey];
    if (!pin) continue;
    if (repin.has(node.stmtKey) || !pin.acceptedDependencies) {
      pin.acceptedDependencies = dependencyMap(node, graph);
      mutated = true;
      continue;
    }
    const changed = changedDependencies(pin.acceptedDependencies, node, graph);
    if (changed.length) {
      block.dependencyWarning = `Pinned code has changed dependencies: ${changed.join(", ")}`;
      diagnostics.push({
        line: block.unit.startLine, endLine: block.unit.endLine,
        message: block.dependencyWarning + (locked ? ". Accept or retranslate it before a locked build." : pin.automatic ? "" : ". Review, accept, or retranslate it."),
        severity: locked ? "error" : "warning", code: "pinned-dependency",
      });
    }
  }

  // An automatic pin freezes code against model variance, not against real
  // dependency changes: when its providers changed, retranslate it now.
  // Manual pins stay and keep their warning.
  if (!locked && opts.translateMissing && (opts.round ?? 0) < 3) {
    const stale = [...blocks, ...exampleBlocks].filter(b => b.dependencyWarning && b.pinned && b.automaticPin);
    if (stale.length) {
      const force = new Set(opts.force ?? []);
      for (const b of stale) {
        const key = stmtKey(b.unit.text);
        delete cache.pins[key];
        force.add(key);
      }
      cache.graph = graph;
      saveCache(eiFile, cache);
      opts.onProgress?.(`dependencies changed: retranslating ${stale.length} statement(s)…`);
      return compile(eiFile, text, cfg, { ...opts, force, round: (opts.round ?? 0) + 1 });
    }
  }

  if ((locked || opts.translateMissing) && !diagnostics.some(d => d.severity === "error" && d.code !== "pinned-dependency")) {
    const err = await syntaxCheck(target, testScript || script);
    if (err) {
      const owner = [...exampleBlocks, ...blocks].find(b => err.line >= b.genStart && err.line <= b.genEnd);
      diagnostics.push({ line: owner?.unit.startLine ?? 0, endLine: owner?.unit.endLine ?? 0, message: `generated ${target} has a syntax error: ${err.message}`, severity: "error", code: "syntax" });
    }
  }

  cache.graph = graph;
  if (mutated || opts.translateMissing || locked) saveCache(eiFile, cache);
  const hoistedLines = ordered.filter(o => o.hoisted).map(o => o.unit.startLine);
  return { survey, target, briefs, script, testScript, blocks, exampleBlocks, modules, diagnostics, hoistedLines, graph, locked };
}

function cachedBriefsAndPrelude(eiFile: string, survey: Survey, target: "bash" | "python"): { briefs: string; prelude: string } {
  let briefs = "", prelude = "";
  if (survey.uses.length && target === "python") prelude = "import sys\n";
  for (const rawUse of survey.uses) {
    const u = resolveUsePath(eiFile, rawUse);
    if (isSourceFile(u)) continue; // module briefs and preludes are rebuilt on compile
    briefs += "\n" + cachedBriefText(u) + "\n";
    prelude += preludeFor(target, u);
  }
  if (prelude) prelude = "# libraries\n" + prelude + "\n";
  return { briefs, prelude };
}

// AST-graph-based cascading staleness. This function does no model calls.
export function staleness(eiFile: string, text: string, cfg: EngineConfig): StalenessInfo {
  const cache = loadCache(eiFile);
  const parsed = parse(text);
  const survey = cache.survey?.value ?? { target: "bash" as const, preambleEnd: 0, uses: [], definitions: [], examples: [] };
  const target = (parsed.explicitTarget === "python" || parsed.explicitTarget === "bash") ? parsed.explicitTarget as "bash" | "python" : survey.target;
  const currentUnits = parsed.units.filter(u => u.kind === "statement" && u.startLine >= survey.preambleEnd);
  const ids = assignNodeIds(currentUnits, cache.graph);
  const graph = cache.graph;
  const oldById = new Map((graph?.nodes ?? []).map(n => [n.id, n]));
  const roots = new Set<string>();
  const staleLines: number[] = [], pinnedLines: number[] = [], dependencyWarningLines: number[] = [];
  const ghost = new Map<number, string>(), reasons = new Map<number, string>();

  for (let i = 0; i < currentUnits.length; i++) {
    const unit = currentUnits[i], id = ids[i], old = oldById.get(id), key = stmtKey(unit.text), pin = cache.pins[key];
    if (pin) { pinnedLines.push(unit.startLine); ghost.set(unit.startLine, pin.code.split("\n")[0] ?? ""); }
    else {
      const prior = Object.values(cache.translations).find(t => t.stmt.trim() === unit.text.trim());
      if (prior) ghost.set(unit.startLine, prior.code.split("\n")[0] ?? "");
    }
    if (!old || old.sourceHash !== sha(unit.text.trim()).slice(0, 24) || !pin) {
      roots.add(id); staleLines.push(unit.startLine);
      reasons.set(unit.startLine, !old ? "new statement" : old.sourceHash !== sha(unit.text.trim()).slice(0, 24) ? "statement changed" : "translation is not pinned");
    }
  }
  if (graph) {
    const currentIds = new Set(ids);
    for (const old of graph.nodes) if (!currentIds.has(old.id)) roots.add(old.id);
    // Target, library, engine, or preamble-only changes can affect all nodes.
    const cached = cachedBriefsAndPrelude(eiFile, survey, target);
    const environmentChanged = graph.target !== target || graph.engineId !== engineId(cfg)
      || (!survey.uses.some(u => /\.ei$/i.test(u)) && graph.briefsHash !== sha(cached.briefs).slice(0, 16));
    if (environmentChanged || (graph.sourceHash !== sha(text).slice(0, 24) && roots.size === 0)) for (const id of ids) roots.add(id);
    const dependents = transitiveDependents(graph, roots);
    const dependentLines: number[] = [];
    for (let i = 0; i < currentUnits.length; i++) {
      if (dependents.has(ids[i]) && !staleLines.includes(currentUnits[i].startLine)) {
        dependentLines.push(currentUnits[i].startLine);
        reasons.set(currentUnits[i].startLine, cache.pins[stmtKey(currentUnits[i].text)] ? "pinned code depends on a changed statement" : "depends on a changed statement");
      }
      const old = oldById.get(ids[i]);
      const pin = cache.pins[stmtKey(currentUnits[i].text)];
      if (old && pin && changedDependencies(pin.acceptedDependencies, old, graph).length) dependencyWarningLines.push(currentUnits[i].startLine);
    }
    return { staleLines: [...new Set(staleLines)], dependentLines, pinnedLines, dependencyWarningLines, ghost, reasons };
  }
  return { staleLines: [...new Set(staleLines)], dependentLines: [], pinnedLines, dependencyWarningLines, ghost, reasons };
}

// ---------------------------------------------------------------- REPL
// RStudio-style interactive use: one statement at a time, JIT-translated
// (pins and cache first), executed in a persistent real REPL process.
export interface ReplSession {
  target: "bash" | "python";
  prelude: string;      // library loading, run once at session start
  sys: string;          // translator system prompt for this program
  sysExample: string;   // expectation-checker prompt
  briefsHash: string;
  preambleEnd: number;  // 1-based; statements before it are description only
  exampleTexts: string[]; // trimmed example statements from the survey
}

export async function replSetup(eiFile: string, text: string, cfg: EngineConfig, onProgress?: (m: string) => void): Promise<ReplSession> {
  const cache = loadCache(eiFile);
  onProgress?.("surveying program…");
  const survey = await surveyCached(eiFile, text, cfg, cache);
  (survey as any).examples ??= []; (survey as any).uses ??= []; (survey as any).definitions ??= [];
  saveCache(eiFile, cache);
  const parsed = parse(text);
  const target = (parsed.explicitTarget === "python" || parsed.explicitTarget === "bash")
    ? parsed.explicitTarget as "bash" | "python" : survey.target;
  const diagnostics: Diag[] = [];
  const { briefs, prelude } = await resolveUses(eiFile, survey, target, cfg, { translateMissing: true, onProgress }, diagnostics, false);
  const err = diagnostics.find(d => d.severity === "error");
  if (err) throw new Error(err.message);
  const outline = survey.definitions.map(d => d.name).join(", ");
  const srcLang = languageOfFile(eiFile) ?? survey.language ?? "a human language (detect it from the text)";
  const exampleLines = new Set(survey.examples.map(e => e.line - 1));
  const exampleTexts = parsed.units
    .filter(u => u.kind === "statement" && exampleLines.has(u.startLine))
    .map(u => u.text.trim());
  return {
    target, prelude,
    sys: translateSys(target, briefs, outline, srcLang),
    sysExample: exampleSys(target, briefs, outline, srcLang),
    briefsHash: sha(briefs).slice(0, 16),
    preambleEnd: survey.preambleEnd,
    exampleTexts,
  };
}

export async function replTranslate(
  eiFile: string, stmt: string, session: ReplSession, sessionCode: string, cfg: EngineConfig,
  kind: "statement" | "example" = "statement",
): Promise<{ code: string; fromCache: boolean; pinned: boolean; kind: "statement" | "example" }> {
  const cache = loadCache(eiFile);
  const pin = cache.pins[stmtKey(stmt)];
  if (pin) return { code: pin.code, fromCache: true, pinned: true, kind };
  const prefix = kind === "example" ? "repl-ex" : "repl";
  const tKey = translationKey(cfg, session.target, session.briefsHash, `${prefix}:${sha(sessionCode).slice(0, 24)}`, stmt);
  const hit = cache.translations[tKey];
  if (hit) return { code: hit.code, fromCache: true, pinned: false, kind };
  const user = kind === "example"
    ? `Program:\n${sessionCode}\n\nExpectation to check: ${stmt}`
    : `Script so far:\n${sessionCode}\n\nStatement to translate: ${stmt}`;
  const code = await llm(kind === "example" ? session.sysExample : session.sys, user, 800, cfg);
  if (!code.trim()) throw new Error("empty translation");
  cache.translations[tKey] = { code, stmt, at: Date.now() };
  saveCache(eiFile, cache);
  return { code, fromCache: false, pinned: false, kind };
}

export function pinStatement(eiFile: string, stmt: string, codeText: string): void {
  const cache = loadCache(eiFile);
  const node = cache.graph?.nodes.find(n => n.stmtKey === stmtKey(stmt));
  cache.pins[stmtKey(stmt)] = {
    code: codeText, stmt, at: Date.now(), automatic: false,
    ...(node && cache.graph ? { acceptedDependencies: dependencyMap(node, cache.graph) } : {}),
  };
  saveCache(eiFile, cache);
}

export function acceptPinDependencies(eiFile: string, stmt: string): boolean {
  const cache = loadCache(eiFile), key = stmtKey(stmt), pin = cache.pins[key];
  const node = cache.graph?.nodes.find(n => n.stmtKey === key);
  if (!pin || !node || !cache.graph) return false;
  pin.acceptedDependencies = dependencyMap(node, cache.graph);
  pin.at = Date.now();
  saveCache(eiFile, cache);
  return true;
}

export function unpinStatement(eiFile: string, stmt: string): boolean {
  const cache = loadCache(eiFile), key = stmtKey(stmt);
  if (!cache.pins[key]) return false;
  delete cache.pins[key]; saveCache(eiFile, cache); return true;
}

export function clearCache(eiFile: string): void {
  saveCache(eiFile, { version: 2, translations: {}, pins: {} });
}
