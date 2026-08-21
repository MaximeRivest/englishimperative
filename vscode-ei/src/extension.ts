import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as vscode from "vscode";
import { acceptPinDependencies, clearCache, compile, pinStatement, replSetup, replTranslate, staleness, unpinStatement } from "./core/compiler";
import type { ReplSession } from "./core/compiler";
import { instrument } from "./core/debug";
import { shutdownWarmPi } from "./core/engine";
import { PY_REPL_HOST } from "./core/replHost";
import { briefFor } from "./core/briefs";
import { loadCache, saveCache, stmtKey } from "./core/cache";
import { parse } from "./core/parser";
import { CompileResult, EngineConfig, Unit } from "./core/types";

const SCHEME = "ei-compiled";

function engineConfig(): EngineConfig {
  const c = vscode.workspace.getConfiguration("ei");
  let modeFile = c.get<string>("pi.modeFile") || "";
  if (!modeFile) {
    const guess = path.join(os.homedir(), "Projects", "englishimperative", "ei-mode.json");
    if (fs.existsSync(guess)) modeFile = guess;
  }
  return {
    engine: (c.get<string>("engine") === "pi" ? "pi" : "http"),
    httpUrl: c.get<string>("http.url") || "",
    httpApiKey: c.get<string>("http.apiKey") || "",
    httpModel: c.get<string>("http.model") || "",
    piModel: c.get<string>("pi.model") || "",
    piModeFile: modeFile,
  };
}

function compiledUri(doc: vscode.TextDocument): vscode.Uri {
  const target = lastResults.get(doc.uri.fsPath)?.target ?? "txt";
  const ext = target === "python" ? "py" : "sh";
  return vscode.Uri.from({ scheme: SCHEME, path: doc.uri.fsPath + `.generated.${ext}`, query: doc.uri.fsPath });
}

const lastResults = new Map<string, CompileResult>();
const contentEmitter = new vscode.EventEmitter<vscode.Uri>();
let compiling = false;

function statementAt(doc: vscode.TextDocument, line: number): Unit | undefined {
  const parsed = parse(doc.getText());
  return parsed.units.find(u => u.kind === "statement" && line >= u.startLine && line <= u.endLine);
}

export function activate(context: vscode.ExtensionContext) {
  const diagnostics = vscode.languages.createDiagnosticCollection("ei");
  const output = vscode.window.createOutputChannel("English Imperative");

  // ---------------------------------------------------------- compiled view
  const provider: vscode.TextDocumentContentProvider = {
    onDidChange: contentEmitter.event,
    provideTextDocumentContent(uri: vscode.Uri): string {
      const result = lastResults.get(uri.query);
      return result?.script ?? "# not compiled yet — run 'EI: Compile'\n";
    },
  };
  context.subscriptions.push(vscode.workspace.registerTextDocumentContentProvider(SCHEME, provider));

  // ---------------------------------------------------------- decorations
  const staleDeco = vscode.window.createTextEditorDecorationType({
    after: { contentText: "  ✎ stale", color: new vscode.ThemeColor("editorWarning.foreground"), fontStyle: "italic" },
    overviewRulerColor: new vscode.ThemeColor("editorWarning.foreground"),
    overviewRulerLane: vscode.OverviewRulerLane.Right,
  });
  const dependentDeco = vscode.window.createTextEditorDecorationType({
    after: { contentText: "  ↳ dependency changed", color: new vscode.ThemeColor("editorWarning.foreground"), fontStyle: "italic" },
    overviewRulerColor: new vscode.ThemeColor("editorWarning.foreground"),
    overviewRulerLane: vscode.OverviewRulerLane.Right,
  });
  const pinWarningDeco = vscode.window.createTextEditorDecorationType({
    after: { contentText: "  📌 dependency review", color: new vscode.ThemeColor("editorError.foreground"), fontStyle: "italic" },
    overviewRulerColor: new vscode.ThemeColor("editorError.foreground"),
    overviewRulerLane: vscode.OverviewRulerLane.Right,
  });
  const pinDeco = vscode.window.createTextEditorDecorationType({
    after: { contentText: "  📌", color: new vscode.ThemeColor("descriptionForeground") },
  });
  const ghostDeco = vscode.window.createTextEditorDecorationType({
    after: { color: new vscode.ThemeColor("editorGhostText.foreground"), fontStyle: "italic" },
  });
  const linkDeco = vscode.window.createTextEditorDecorationType({
    backgroundColor: new vscode.ThemeColor("editor.rangeHighlightBackground"),
    isWholeLine: true,
  });

  let decoTimer: NodeJS.Timeout | undefined;
  function refreshDecorations(editor: vscode.TextEditor | undefined) {
    if (!editor || editor.document.languageId !== "ei" || editor.document.uri.scheme !== "file") return;
    const cfgAll = vscode.workspace.getConfiguration("ei");
    const info = staleness(editor.document.uri.fsPath, editor.document.getText(), engineConfig());
    const lineEnd = (n: number) => {
      if (n >= editor.document.lineCount) return new vscode.Range(0, 0, 0, 0);
      const len = editor.document.lineAt(n).text.length;
      return new vscode.Range(n, len, n, len);
    };
    editor.setDecorations(staleDeco, info.staleLines.map(lineEnd));
    editor.setDecorations(dependentDeco, info.dependentLines.filter(n => !info.pinnedLines.includes(n)).map(lineEnd));
    editor.setDecorations(pinWarningDeco, [...new Set([...info.dependencyWarningLines, ...info.dependentLines.filter(n => info.pinnedLines.includes(n))])].map(lineEnd));
    editor.setDecorations(pinDeco, info.pinnedLines.filter(n => !info.dependencyWarningLines.includes(n) && !info.dependentLines.includes(n)).map(lineEnd));
    if (cfgAll.get<boolean>("ghostCode")) {
      const ghosts: vscode.DecorationOptions[] = [];
      for (const [line, code] of info.ghost) {
        if (info.staleLines.includes(line) || !code) continue;
        const parsed = parse(editor.document.getText());
        const unit = parsed.units.find(u => u.startLine === line);
        const end = unit ? unit.endLine : line;
        if (end >= editor.document.lineCount) continue;
        const len = editor.document.lineAt(end).text.length;
        ghosts.push({
          range: new vscode.Range(end, len, end, len),
          renderOptions: { after: { contentText: `  ⟶ ${code.length > 80 ? code.slice(0, 77) + "…" : code}` } },
        });
      }
      editor.setDecorations(ghostDeco, ghosts);
    } else {
      editor.setDecorations(ghostDeco, []);
    }
  }
  function scheduleDecorations() {
    clearTimeout(decoTimer);
    decoTimer = setTimeout(() => refreshDecorations(vscode.window.activeTextEditor), 300);
  }

  // ---------------------------------------------------------- compile
  async function doCompile(doc: vscode.TextDocument, opts?: { force?: Set<string>; locked?: boolean }): Promise<CompileResult | undefined> {
    if (compiling) { vscode.window.showInformationMessage("EI: a compile is already running."); return; }
    compiling = true;
    statusItem.text = "$(sync~spin) EI compiling";
    try {
      return await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Window, title: "EI compile" },
        async (progress, token) => {
          const result = await compile(doc.uri.fsPath, doc.getText(), engineConfig(), {
            translateMissing: !opts?.locked,
            locked: !!opts?.locked,
            pinByDefault: vscode.workspace.getConfiguration("ei").get<boolean>("pinByDefault", true),
            lint: vscode.workspace.getConfiguration("ei").get<boolean>("lint", true),
            force: opts?.force,
            onProgress: m => { progress.report({ message: m }); output.appendLine(`ei: ${m}`); },
            token,
          });
          lastResults.set(doc.uri.fsPath, result);
          contentEmitter.fire(compiledUri(doc));
          diagnostics.set(doc.uri, result.diagnostics.map(d => {
            const endLine = Math.min(d.endLine, doc.lineCount - 1);
            const range = new vscode.Range(d.line, 0, endLine, doc.lineAt(endLine).text.length);
            const diag = new vscode.Diagnostic(range, d.message,
              d.severity === "error" ? vscode.DiagnosticSeverity.Error : vscode.DiagnosticSeverity.Warning);
            diag.source = "ei";
            return diag;
          }));
          const defs = result.survey.definitions.map(d => d.name).join(", ");
          output.appendLine(`ei: target=${result.target} libraries=${result.survey.uses.length} definitions=${defs || "none"} graph=${result.graph.nodes.length} nodes${result.locked ? " locked" : ""}`);
          return result;
        });
    } catch (e: any) {
      vscode.window.showErrorMessage(`EI compile failed: ${e?.message ?? e}`);
      return undefined;
    } finally {
      compiling = false;
      updateStatus();
      scheduleDecorations();
      codeLensEmitter.fire();
    }
  }

  async function showCompiled(doc: vscode.TextDocument) {
    const uri = compiledUri(doc);
    const vdoc = await vscode.workspace.openTextDocument(uri);
    const target = lastResults.get(doc.uri.fsPath)?.target;
    await vscode.languages.setTextDocumentLanguage(vdoc, target === "python" ? "python" : "shellscript");
    await vscode.window.showTextDocument(vdoc, { viewColumn: vscode.ViewColumn.Beside, preserveFocus: true, preview: false });
  }

  function graphMarkdown(result: CompileResult): string {
    const clean = (s: string) => s.replace(/[\n\r|`]/g, " ").replace(/"/g, "'").slice(0, 70);
    const lines = ["# English Imperative dependency graph", "", "```mermaid", "flowchart TD"];
    for (const n of result.graph.nodes) {
      const label = n.facts.defines.length ? n.facts.defines.join(", ") : n.stmt.split("\n")[0];
      lines.push(`  ${n.id.replace(/-/g, "_")}[\"${clean(label)}\"]`);
    }
    for (const n of result.graph.nodes) for (const d of n.dependencies) {
      const label = d.symbols.length ? d.symbols.join(", ") : d.kind;
      lines.push(`  ${d.nodeId.replace(/-/g, "_")} -->|${clean(label)}| ${n.id.replace(/-/g, "_")}`);
    }
    lines.push("```", "", "## Semantic facts", "", "| Statement | Defines | Reads | Calls | Effects | Source | Interface | Implementation |", "|---|---|---|---|---|---|---|---|");
    for (const n of result.graph.nodes) lines.push(`| ${clean(n.stmt.split("\n")[0])} | ${n.facts.defines.join(", ")} | ${n.facts.reads.join(", ")} | ${n.facts.calls.join(", ")} | ${n.facts.effects.join(", ")} | \`${n.sourceHash}\` | \`${n.interfaceHash}\` | \`${n.implementationHash}\` |`);
    return lines.join("\n");
  }

  // ------------------------------------------------------------- REPL
  // A real ei REPL: the terminal runs a host prompt (ei>) that accepts BOTH
  // natural language and Python. English goes to a local translation server
  // in this extension (pins, cache, warm engine), the generated code echoes
  // as ⟶ lines, and state persists in the host process. Shift+Enter simply
  // types the statement into that prompt. Like RStudio, but bilingual.
  interface LiveRepl { session: ReplSession; terminal: vscode.Terminal; code: string; token: string; terminalDoc?: string }
  const repls = new Map<string, LiveRepl>();       // eiFile -> live session
  const replsByToken = new Map<string, LiveRepl>();
  let replServer: import("node:http").Server | undefined;
  let replPort = 0;

  async function ensureReplServer(): Promise<number> {
    if (replServer && replPort) return replPort;
    const http = require("node:http") as typeof import("node:http");
    replServer = http.createServer((req, res) => {
      if (req.method !== "POST" || req.url !== "/translate") { res.statusCode = 404; res.end(); return; }
      let body = "";
      req.on("data", d => body += d);
      req.on("end", async () => {
        const reply = (obj: unknown) => { res.setHeader("Content-Type", "application/json"); res.end(JSON.stringify(obj)); };
        try {
          const { token, text } = JSON.parse(body);
          const live = replsByToken.get(String(token));
          if (!live) { reply({ error: "unknown session; restart the REPL" }); return; }
          const stmt = String(text).trim();
          const kind = live.session.exampleTexts.includes(stmt) ? "example" : "statement";
          const r = await replTranslate(live.terminalDoc ?? "", stmt, live.session, live.code, engineConfig(), kind);
          live.code += r.code.endsWith("\n") ? r.code : r.code + "\n";
          output.appendLine(`repl${r.pinned ? " (pinned)" : r.fromCache ? " (cached)" : ""}: ${stmt.split("\n")[0]}`);
          reply({ code: r.code, kind: r.kind });
        } catch (e: any) {
          reply({ error: String(e?.message ?? e) });
        }
      });
    });
    await new Promise<void>(resolve => replServer!.listen(0, "127.0.0.1", resolve));
    replPort = (replServer.address() as any).port;
    context.subscriptions.push({ dispose: () => { try { replServer?.close(); } catch {} } });
    return replPort;
  }

  async function getRepl(doc: vscode.TextDocument): Promise<LiveRepl> {
    const key = doc.uri.fsPath;
    const existing = repls.get(key);
    if (existing && vscode.window.terminals.includes(existing.terminal)) return existing;
    const session = await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Window, title: "EI REPL" },
      progress => replSetup(key, doc.getText(), engineConfig(), m => progress.report({ message: m })));
    const port = await ensureReplServer();
    const token = Math.random().toString(36).slice(2);
    let terminal: vscode.Terminal;
    if (session.target === "python") {
      const hostFile = path.join(os.tmpdir(), `ei-repl-host-${token}.py`);
      fs.writeFileSync(hostFile, PY_REPL_HOST);
      let preludeFile = "";
      if (session.prelude.trim()) {
        preludeFile = path.join(os.tmpdir(), `ei-repl-prelude-${token}.py`);
        fs.writeFileSync(preludeFile, session.prelude);
      }
      terminal = vscode.window.createTerminal({
        name: "ei repl",
        cwd: path.dirname(key),
        shellPath: "python3",
        shellArgs: [hostFile],
        env: { EI_REPL_PORT: String(port), EI_REPL_TOKEN: token, EI_REPL_PRELUDE: preludeFile },
      });
    } else {
      // bash: a plain shell; generated code is typed in directly, so it stays
      // visible and native. English still arrives through Shift+Enter.
      terminal = vscode.window.createTerminal({ name: "ei repl", cwd: path.dirname(key), shellPath: "bash" });
      if (session.prelude.trim()) terminal.sendText(session.prelude.trimEnd());
    }
    const live: LiveRepl & { terminalDoc?: string } = { session, terminal, code: "", token, terminalDoc: key };
    repls.set(key, live);
    replsByToken.set(token, live);
    terminal.show(true);
    return live;
  }

  context.subscriptions.push(vscode.window.onDidCloseTerminal(t => {
    for (const [key, live] of repls) if (live.terminal === t) { repls.delete(key); replsByToken.delete(live.token); }
  }));

  let skipNextSaveCompile = false;
  async function saveForCommand(doc: vscode.TextDocument) {
    if (!doc.isDirty) return;
    skipNextSaveCompile = true;
    await doc.save();
  }

  // ---------------------------------------------------------- commands
  const activeEiDoc = (): vscode.TextDocument | undefined => {
    const ed = vscode.window.activeTextEditor;
    return ed && ed.document.languageId === "ei" ? ed.document : undefined;
  };

  context.subscriptions.push(
    vscode.commands.registerCommand("ei.compile", async () => {
      const doc = activeEiDoc(); if (!doc) return;
      await saveForCommand(doc);
      const r = await doCompile(doc);
      if (r) await showCompiled(doc);
    }),

    vscode.commands.registerCommand("ei.run", async () => {
      const doc = activeEiDoc(); if (!doc) return;
      await saveForCommand(doc);
      const fresh = await doCompile(doc);
      if (!fresh || fresh.diagnostics.some(d => d.severity === "error")) return;
      const tmp = path.join(os.tmpdir(), `ei-vsc-run-${Date.now()}.${fresh.target === "python" ? "py" : "sh"}`);
      fs.writeFileSync(tmp, fresh.script, { mode: 0o755 });
      const term = vscode.window.terminals.find(t => t.name === "ei") ?? vscode.window.createTerminal("ei");
      term.show(true);
      term.sendText(`cd ${JSON.stringify(path.dirname(doc.uri.fsPath))} && ${fresh.target === "python" ? "python3" : "bash"} ${tmp}`);
    }),

    vscode.commands.registerCommand("ei.showCompiled", async () => {
      const doc = activeEiDoc(); if (!doc) return;
      if (!lastResults.has(doc.uri.fsPath)) await doCompile(doc);
      await showCompiled(doc);
    }),

    vscode.commands.registerCommand("ei.compileToFile", async () => {
      const doc = activeEiDoc(); if (!doc) return;
      await saveForCommand(doc);
      const result = await doCompile(doc);
      if (!result) return;
      const ext = result.target === "python" ? "py" : "sh";
      const out = doc.uri.fsPath.replace(/\.ei$/, "") + "." + ext;
      fs.writeFileSync(out, result.script, { mode: 0o755 });
      vscode.window.showInformationMessage(`EI: wrote ${out}`);
    }),

    vscode.commands.registerCommand("ei.retranslateStatement", async (line?: number) => {
      const doc = activeEiDoc(); if (!doc) return;
      const at = line ?? vscode.window.activeTextEditor?.selection.active.line ?? 0;
      const unit = statementAt(doc, at);
      if (!unit) { vscode.window.showInformationMessage("EI: no statement on this line."); return; }
      await doCompile(doc, { force: new Set([stmtKey(unit.text)]) });
    }),

    vscode.commands.registerCommand("ei.pinStatement", async (line?: number) => {
      const doc = activeEiDoc(); if (!doc) return;
      const at = line ?? vscode.window.activeTextEditor?.selection.active.line ?? 0;
      const unit = statementAt(doc, at);
      if (!unit) { vscode.window.showInformationMessage("EI: no statement on this line."); return; }
      const result = lastResults.get(doc.uri.fsPath);
      const block = result?.blocks.find(b => b.unit.startLine === unit.startLine);
      if (!block?.code) { vscode.window.showWarningMessage("EI: compile first, then pin."); return; }
      pinStatement(doc.uri.fsPath, unit.text, block.code);
      vscode.window.showInformationMessage("EI: pinned. Recompiles keep this code.");
      scheduleDecorations(); codeLensEmitter.fire();
    }),

    vscode.commands.registerCommand("ei.unpinStatement", async (line?: number) => {
      const doc = activeEiDoc(); if (!doc) return;
      const at = line ?? vscode.window.activeTextEditor?.selection.active.line ?? 0;
      const unit = statementAt(doc, at);
      if (!unit || !unpinStatement(doc.uri.fsPath, unit.text)) {
        vscode.window.showInformationMessage("EI: no pin on this statement.");
        return;
      }
      vscode.window.showInformationMessage("EI: unpinned.");
      scheduleDecorations(); codeLensEmitter.fire();
    }),

    vscode.commands.registerCommand("ei.rebuildBriefs", async () => {
      const doc = activeEiDoc(); if (!doc) return;
      const cache = loadCache(doc.uri.fsPath);
      const uses = cache.survey?.value.uses ?? [];
      if (!uses.length) { vscode.window.showInformationMessage("EI: no libraries surveyed yet; compile first."); return; }
      for (const u of uses) {
        output.appendLine(`ei: rebuilding brief for ${u}`);
        await briefFor(u, engineConfig(), true);
      }
      vscode.window.showInformationMessage(`EI: rebuilt ${uses.length} brief(s).`);
    }),

    vscode.commands.registerCommand("ei.clearCache", async () => {
      const doc = activeEiDoc(); if (!doc) return;
      clearCache(doc.uri.fsPath);
      lastResults.delete(doc.uri.fsPath);
      contentEmitter.fire(compiledUri(doc));
      vscode.window.showInformationMessage("EI: translation cache cleared (pins removed too).");
      scheduleDecorations(); codeLensEmitter.fire();
    }),

    vscode.commands.registerCommand("ei.sendToRepl", async () => {
      const editor = vscode.window.activeTextEditor;
      const doc = activeEiDoc(); if (!doc || !editor) return;
      const line = editor.selection.active.line;
      const parsed = parse(doc.getText());
      const advance = () => {
        const next = parsed.units.find(u => u.kind === "statement" && u.startLine > line);
        const target = next ? next.startLine : Math.min(line + 1, doc.lineCount - 1);
        editor.selection = new vscode.Selection(target, 0, target, 0);
        editor.revealRange(new vscode.Range(target, 0, target, 0));
      };
      const unit = statementAt(doc, line);
      if (!unit) { advance(); return; }
      try {
        const live = await getRepl(doc);
        // a description line: state nothing, execute nothing
        if (unit.startLine < live.session.preambleEnd) {
          vscode.window.showInformationMessage("EI: that line describes the program; skipped.");
          advance(); return;
        }
        if (live.session.target === "python") {
          // the host prompt accepts English directly; examples are detected
          // by the translation server, which uses the expectation checker
          live.terminal.show(true);
          live.terminal.sendText(unit.text + "\n");
        } else {
          // bash shows typed code natively; translate here, send the code
          const { code, fromCache, pinned } = await vscode.window.withProgress(
            { location: vscode.ProgressLocation.Window, title: "EI translate" },
            () => replTranslate(doc.uri.fsPath, unit.text, live.session, live.code, engineConfig()));
          output.appendLine(`repl${pinned ? " (pinned)" : fromCache ? " (cached)" : ""}: ${unit.text.split("\n")[0]}`);
          live.code += code.endsWith("\n") ? code : code + "\n";
          live.terminal.show(true);
          live.terminal.sendText(code.trimEnd());
        }
        advance();
      } catch (e: any) {
        vscode.window.showErrorMessage(`EI REPL: ${e?.message ?? e}`);
      }
    }),

    vscode.commands.registerCommand("ei.replReset", async () => {
      const doc = activeEiDoc(); if (!doc) return;
      const live = repls.get(doc.uri.fsPath);
      if (live) { try { live.terminal.dispose(); } catch {} repls.delete(doc.uri.fsPath); }
      vscode.window.showInformationMessage("EI: the REPL session restarts on the next Shift+Enter.");
    }),

    vscode.commands.registerCommand("ei.runTests", async () => {
      const doc = activeEiDoc(); if (!doc) return;
      await saveForCommand(doc);
      const result = await doCompile(doc);
      if (!result) return;
      if (!result.testScript) { vscode.window.showInformationMessage("EI: this program states no examples to test."); return; }
      const tmp = path.join(os.tmpdir(), `ei-vsc-test-${Date.now()}.${result.target === "python" ? "py" : "sh"}`);
      fs.writeFileSync(tmp, result.testScript, { mode: 0o755 });
      const { execFile } = require("node:child_process") as typeof import("node:child_process");
      const stdout: string = await new Promise(resolve => {
        execFile(result.target === "python" ? "python3" : "bash", [tmp], { timeout: 120000, maxBuffer: 8 * 1024 * 1024, cwd: path.dirname(doc.uri.fsPath) },
          (_e, so) => resolve(String(so ?? "")));
      });
      try { fs.unlinkSync(tmp); } catch {}
      output.appendLine(stdout.trim());
      const results = new Map<number, { pass: boolean; message: string }>();
      for (const line of stdout.split("\n")) {
        const m = /^EI-TEST (\d+) (PASS|FAIL) ?(.*)$/.exec(line.trim());
        if (m) results.set(parseInt(m[1], 10) - 1, { pass: m[2] === "PASS", message: m[3] });
      }
      const testDiags: vscode.Diagnostic[] = [];
      let passed = 0, failed = 0;
      for (const block of result.exampleBlocks) {
        const r = results.get(block.unit.startLine);
        const endLine = Math.min(block.unit.endLine, doc.lineCount - 1);
        const range = new vscode.Range(block.unit.startLine, 0, endLine, doc.lineAt(endLine).text.length);
        if (!r || !r.pass) {
          failed++;
          const d = new vscode.Diagnostic(range, `example failed: ${r?.message || "the check did not run"}`, vscode.DiagnosticSeverity.Error);
          d.source = "ei-test"; testDiags.push(d);
        } else {
          passed++;
          const d = new vscode.Diagnostic(range, `example passed: ${r.message}`, vscode.DiagnosticSeverity.Information);
          d.source = "ei-test"; testDiags.push(d);
        }
      }
      const existing = (diagnostics.get(doc.uri) ?? []).filter(d => d.source !== "ei-test");
      diagnostics.set(doc.uri, [...existing, ...testDiags]);
      (failed ? vscode.window.showErrorMessage : vscode.window.showInformationMessage)(`EI tests: ${passed} passed, ${failed} failed.`);
    }),

    vscode.commands.registerCommand("ei.debug", async () => {
      const doc = activeEiDoc(); if (!doc) return;
      await saveForCommand(doc);
      const result = await doCompile(doc);
      if (!result || result.diagnostics.some(d => d.severity === "error")) return;
      const tmp = path.join(os.tmpdir(), `ei-vsc-debug-${Date.now()}.${result.target === "python" ? "py" : "sh"}`);
      fs.writeFileSync(tmp, instrument(result), { mode: 0o755 });
      const term = vscode.window.terminals.find(t => t.name === "ei debug") ?? vscode.window.createTerminal("ei debug");
      term.show(false);
      term.sendText(`cd ${JSON.stringify(path.dirname(doc.uri.fsPath))} && ${result.target === "python" ? "python3" : "bash"} ${tmp}`);
    }),

    vscode.commands.registerCommand("ei.lockedBuild", async () => {
      const doc = activeEiDoc(); if (!doc) return;
      if (doc.isDirty) { vscode.window.showErrorMessage("EI locked build: save and complete a development compile first."); return; }
      const result = await doCompile(doc, { locked: true });
      if (!result) return;
      const errors = result.diagnostics.filter(d => d.severity === "error");
      if (errors.length) vscode.window.showErrorMessage(`EI locked build failed with ${errors.length} error(s). No model was called.`);
      else { vscode.window.showInformationMessage("EI locked build passed. No model was called."); await showCompiled(doc); }
    }),

    vscode.commands.registerCommand("ei.showDependencyGraph", async () => {
      const doc = activeEiDoc(); if (!doc) return;
      const result = lastResults.get(doc.uri.fsPath) ?? await doCompile(doc);
      if (!result) return;
      const graphDoc = await vscode.workspace.openTextDocument({ language: "markdown", content: graphMarkdown(result) });
      await vscode.window.showTextDocument(graphDoc, { viewColumn: vscode.ViewColumn.Beside, preview: false });
    }),

    vscode.commands.registerCommand("ei.acceptPinDependencies", async (line?: number) => {
      const doc = activeEiDoc(); if (!doc) return;
      const at = line ?? vscode.window.activeTextEditor?.selection.active.line ?? 0;
      const unit = statementAt(doc, at);
      if (!unit || !acceptPinDependencies(doc.uri.fsPath, unit.text)) {
        vscode.window.showInformationMessage("EI: no current pinned dependency change to accept."); return;
      }
      vscode.window.showInformationMessage("EI: accepted the current dependency interfaces. The pinned code did not change.");
      await doCompile(doc, { locked: true });
    }),

    vscode.commands.registerCommand("ei.selectEngine", async () => {
      const c = vscode.workspace.getConfiguration("ei");
      const engine = await vscode.window.showQuickPick(
        [
          { label: "http", description: `OpenAI-compatible endpoint (${c.get("http.model")})` },
          { label: "pi", description: "pi CLI with its extensions and modes" },
        ],
        { title: "EI engine" });
      if (!engine) return;
      await c.update("engine", engine.label, vscode.ConfigurationTarget.Workspace);
      if (engine.label === "pi") {
        const { execFile } = require("node:child_process") as typeof import("node:child_process");
        const models: string[] = await new Promise(resolve => {
          execFile("pi", ["--list-models"], { timeout: 30000, maxBuffer: 8 * 1024 * 1024 }, (_e, stdout) => {
            const rows = String(stdout ?? "").split("\n").slice(1)
              .map(l => l.trim().split(/\s{2,}/))
              .filter(p => p.length >= 2 && p[0])
              .map(p => `${p[0]}/${p[1]}`);
            resolve(rows);
          });
        });
        const pick = await vscode.window.showQuickPick(models, { title: "pi model (provider/id)", placeHolder: c.get("pi.model") || "pi default" });
        if (pick) await c.update("pi.model", pick, vscode.ConfigurationTarget.Workspace);
      }
      updateStatus();
      scheduleDecorations();
    }),
  );

  // ---------------------------------------------------------- code lenses
  const codeLensEmitter = new vscode.EventEmitter<void>();
  context.subscriptions.push(vscode.languages.registerCodeLensProvider({ language: "ei" }, {
    onDidChangeCodeLenses: codeLensEmitter.event,
    provideCodeLenses(doc) {
      const lenses: vscode.CodeLens[] = [];
      const top = new vscode.Range(0, 0, 0, 0);
      lenses.push(new vscode.CodeLens(top, { title: "$(play) Run", command: "ei.run" }));
      lenses.push(new vscode.CodeLens(top, { title: "$(gear) Compile", command: "ei.compile" }));
      lenses.push(new vscode.CodeLens(top, { title: "$(beaker) Tests", command: "ei.runTests" }));
      lenses.push(new vscode.CodeLens(top, { title: "$(debug) Debug", command: "ei.debug" }));
      lenses.push(new vscode.CodeLens(top, { title: "$(lock) Locked build", command: "ei.lockedBuild" }));
      lenses.push(new vscode.CodeLens(top, { title: "$(type-hierarchy) Dependency graph", command: "ei.showDependencyGraph" }));
      const result = lastResults.get(doc.uri.fsPath);
      if (result) {
        const defs = result.survey.definitions.map(d => d.name).join(", ");
        lenses.push(new vscode.CodeLens(top, {
          title: `target: ${result.target} · libraries: ${result.survey.uses.length}` + (defs ? ` · defines: ${defs}` : ""),
          command: "ei.showCompiled",
        }));
      }
      const cache = loadCache(doc.uri.fsPath);
      const parsed = parse(doc.getText());
      for (const u of parsed.units) {
        if (u.kind !== "statement") continue;
        const range = new vscode.Range(u.startLine, 0, u.startLine, 0);
        const pin = cache.pins[stmtKey(u.text)];
        const block = result?.blocks.find(b => b.unit.startLine === u.startLine);
        lenses.push(new vscode.CodeLens(range, { title: "show code", command: "ei.showCompiled" }));
        lenses.push(new vscode.CodeLens(range, { title: "retranslate", command: "ei.retranslateStatement", arguments: [u.startLine] }));
        lenses.push(new vscode.CodeLens(range, pin
          ? { title: pin.automatic ? "auto-pinned · unpin" : "pinned · unpin", command: "ei.unpinStatement", arguments: [u.startLine] }
          : { title: "pin", command: "ei.pinStatement", arguments: [u.startLine] }));
        if (block?.dependencyWarning) lenses.push(new vscode.CodeLens(range, { title: "$(warning) accept dependency changes", command: "ei.acceptPinDependencies", arguments: [u.startLine] }));
      }
      return lenses;
    },
  }));

  // ---------------------------------------------------------- hover
  context.subscriptions.push(vscode.languages.registerHoverProvider({ language: "ei" }, {
    provideHover(doc, pos) {
      const unit = statementAt(doc, pos.line);
      if (!unit) return;
      const result = lastResults.get(doc.uri.fsPath);
      const block = result?.blocks.find(b => b.unit.startLine === unit.startLine && b.unit.text === unit.text);
      const cache = loadCache(doc.uri.fsPath);
      const pin = cache.pins[stmtKey(unit.text)];
      const code = pin?.code ?? block?.code
        ?? Object.values(cache.translations).find(t => t.stmt.trim() === unit.text.trim())?.code;
      if (!code) return new vscode.Hover(new vscode.MarkdownString("*not translated yet — run `EI: Compile`*"));
      const lang = (result?.target ?? cache.survey?.value.target) === "python" ? "python" : "bash";
      const md = new vscode.MarkdownString();
      if (pin) md.appendMarkdown(`📌 **${pin.automatic ? "automatically pinned" : "pinned"}**\n\n`);
      if (block?.dependencyWarning) md.appendMarkdown(`⚠️ **${block.dependencyWarning}**\n\n`);
      md.appendCodeblock(code, lang);
      if (block?.facts) {
        const f = block.facts;
        md.appendMarkdown(`\n**Defines:** ${f.defines.join(", ") || "none"}  \n`);
        md.appendMarkdown(`**Reads:** ${f.reads.join(", ") || "none"}  \n`);
        md.appendMarkdown(`**Calls:** ${f.calls.join(", ") || "none"}  \n`);
        md.appendMarkdown(`**Effects:** ${f.effects.join(", ") || "none"}  \n`);
        md.appendMarkdown(`**Hashes:** source \`${block.sourceHash}\` · interface \`${block.interfaceHash}\` · implementation \`${block.implementationHash}\``);
      }
      return new vscode.Hover(md, new vscode.Range(unit.startLine, 0, unit.endLine, doc.lineAt(unit.endLine).text.length));
    },
  }));

  // ---------------------------------------------------------- source map link
  context.subscriptions.push(vscode.window.onDidChangeTextEditorSelection(ev => {
    const doc = ev.textEditor.document;
    if (doc.languageId !== "ei" || doc.uri.scheme !== "file") return;
    const result = lastResults.get(doc.uri.fsPath);
    if (!result) return;
    const block = result.blocks.find(b => ev.selections[0].active.line >= b.unit.startLine && ev.selections[0].active.line <= b.unit.endLine);
    const target = compiledUri(doc).toString();
    const compiledEditor = vscode.window.visibleTextEditors.find(e => e.document.uri.toString() === target);
    if (!compiledEditor) return;
    if (!block) { compiledEditor.setDecorations(linkDeco, []); return; }
    const range = new vscode.Range(block.genStart, 0, Math.min(block.genEnd, compiledEditor.document.lineCount - 1), 0);
    compiledEditor.setDecorations(linkDeco, [range]);
    compiledEditor.revealRange(range, vscode.TextEditorRevealType.InCenterIfOutsideViewport);
  }));

  // ---------------------------------------------------------- status bar
  const statusItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 90);
  statusItem.command = "ei.selectEngine";
  context.subscriptions.push(statusItem);
  function updateStatus() {
    const cfg = engineConfig();
    statusItem.text = cfg.engine === "pi"
      ? `$(rocket) EI: pi ${cfg.piModel || "default"}`
      : `$(rocket) EI: http ${cfg.httpModel}`;
    statusItem.tooltip = "English Imperative: select engine and model";
    if (vscode.window.activeTextEditor?.document.languageId === "ei") statusItem.show(); else statusItem.hide();
  }
  updateStatus();

  // ---------------------------------------------------------- events
  context.subscriptions.push(
    vscode.workspace.onDidSaveTextDocument(async doc => {
      if (doc.languageId !== "ei") return;
      if (skipNextSaveCompile) { skipNextSaveCompile = false; return; }
      if (vscode.workspace.getConfiguration("ei").get<boolean>("compileOnSave")) {
        await doCompile(doc);
      }
    }),
    vscode.workspace.onDidChangeTextDocument(ev => {
      if (ev.document.languageId === "ei") { scheduleDecorations(); codeLensEmitter.fire(); }
    }),
    vscode.window.onDidChangeActiveTextEditor(() => { updateStatus(); scheduleDecorations(); }),
    vscode.workspace.onDidChangeConfiguration(ev => {
      if (ev.affectsConfiguration("ei")) { updateStatus(); scheduleDecorations(); }
    }),
  );
  scheduleDecorations();

  // tidy explorer: keep generated files out of sight (sources stay alone)
  function applyTidyExplorer() {
    const on = vscode.workspace.getConfiguration("ei").get<boolean>("tidyExplorer", true);
    for (const folder of vscode.workspace.workspaceFolders ?? []) {
      const files = vscode.workspace.getConfiguration("files", folder.uri);
      void files.update("exclude", { "**/*.eic.json": on, "**/.ei-build": on }, vscode.ConfigurationTarget.WorkspaceFolder);
    }
  }
  applyTidyExplorer();

  // prose wraps like a document: wordWrap on for the ei language only
  function applyWordWrap() {
    const on = vscode.workspace.getConfiguration("ei").get<boolean>("wordWrap", true);
    void vscode.workspace.getConfiguration("editor", { languageId: "ei", uri: vscode.window.activeTextEditor?.document.uri })
      .update("wordWrap", on ? "on" : undefined, vscode.ConfigurationTarget.Global);
  }
  applyWordWrap();

  context.subscriptions.push(vscode.workspace.onDidChangeConfiguration(ev => {
    if (ev.affectsConfiguration("ei.tidyExplorer")) applyTidyExplorer();
    if (ev.affectsConfiguration("ei.wordWrap")) applyWordWrap();
  }));
}

export function deactivate() { shutdownWarmPi(); }
