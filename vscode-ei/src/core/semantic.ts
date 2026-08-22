import { spawn } from "node:child_process";
import { sha, stmtKey } from "./cache";
import { DependencyEdge, DependencyGraph, Effect, GraphNode, SemanticFacts, Target, Unit } from "./types";

const PY_ANALYZER = String.raw`
import ast, builtins, json, symtable, sys
B=set(dir(builtins))

def dotted(node):
    if isinstance(node, ast.Name): return node.id
    if isinstance(node, ast.Attribute):
        left=dotted(node.value)
        return (left+'.' if left else '')+node.attr
    return ''

def targets(node):
    if isinstance(node, ast.Name): return [node.id]
    if isinstance(node, (ast.Tuple,ast.List)):
        out=[]
        for x in node.elts: out += targets(x)
        return out
    return []

def analyze(code):
    out={'defines':[],'reads':[],'calls':[],'imports':[],'functions':[],
         'classes':[],'effects':[],'dynamic':False}
    try:
        tree=ast.parse(code)
        table=symtable.symtable(code,'<ei-block>','exec')
    except Exception as e:
        out['parseError']=str(e); return out

    defines=set(); reads=set(); imports=set(); calls=set(); effects=set()
    for s in table.get_symbols():
        if s.is_assigned() or s.is_imported() or s.is_namespace(): defines.add(s.get_name())
        if s.is_referenced(): reads.add(s.get_name())
    def child_reads(t):
        for s in t.get_symbols():
            if s.is_referenced() and (s.is_global() or s.is_free()): reads.add(s.get_name())
        for c in t.get_children(): child_reads(c)
    for c in table.get_children(): child_reads(c)

    for n in ast.walk(tree):
        if isinstance(n,(ast.Import,ast.ImportFrom)):
            if isinstance(n,ast.Import):
                for a in n.names: imports.add(a.name); defines.add(a.asname or a.name.split('.')[0])
            else:
                mod=n.module or ''
                imports.add(mod)
                for a in n.names:
                    if a.name=='*': out['dynamic']=True
                    else: defines.add(a.asname or a.name)
        if isinstance(n,(ast.FunctionDef,ast.AsyncFunctionDef)) and n in tree.body:
            args=[]
            allargs=list(n.args.posonlyargs)+list(n.args.args)+list(n.args.kwonlyargs)
            if n.args.vararg: allargs.append(n.args.vararg)
            if n.args.kwarg: allargs.append(n.args.kwarg)
            args=[a.arg for a in allargs]
            required=max(0,len(n.args.posonlyargs)+len(n.args.args)-len(n.args.defaults))
            required += sum(1 for d in n.args.kw_defaults if d is None)
            out['functions'].append({'name':n.name,'parameters':args,'requiredParameters':required,'async':isinstance(n,ast.AsyncFunctionDef)})
        if isinstance(n,ast.ClassDef) and n in tree.body: out['classes'].append(n.name)
        if isinstance(n,ast.Call):
            name=dotted(n.func); calls.add(name or '<dynamic-call>')
            low=name.lower()
            if low in ('eval','exec','globals','locals','__import__') or low.endswith('.getattr'): out['dynamic']=True; effects.add('unknown_dynamic')
            if low=='open':
                mode='r'
                if len(n.args)>1 and isinstance(n.args[1],ast.Constant): mode=str(n.args[1].value)
                for kw in n.keywords:
                    if kw.arg=='mode' and isinstance(kw.value,ast.Constant): mode=str(kw.value.value)
                effects.add('writes_files' if any(x in mode for x in 'wax+') else 'reads_files')
            if any(x in low for x in ('path.read_text','path.read_bytes','.read_csv','.read_json','.loadtxt')): effects.add('reads_files')
            if any(x in low for x in ('path.write_text','path.write_bytes','.to_csv','.to_json','.savefig')): effects.add('writes_files')
            if any(x in low for x in ('requests.','httpx.','urllib.','socket.','.urlopen','.fetch')): effects.add('uses_network')
            if low.startswith('subprocess.') or low in ('os.system','os.popen'): effects.add('starts_process')
            if any(x in low for x in ('os.remove','os.unlink','os.rmdir','shutil.rmtree','path.unlink','.drop_table','.delete')): effects.add('deletes_data')
            if any(x in low for x in ('.commit','.execute','.executemany','.insert','.update')): effects.add('writes_database')
            if any(x in low for x in ('.query','.select','.fetchone','.fetchall','read_sql')): effects.add('reads_database')
            if low.startswith('random.') or low in ('random','secrets.token_bytes','uuid.uuid4'): effects.add('uses_randomness')
            if low in ('time.time','time.monotonic','datetime.now','datetime.datetime.now','date.today','datetime.date.today'): effects.add('uses_time')
    out['defines']=sorted(defines)
    out['reads']=sorted(x for x in reads if x not in B)
    out['calls']=sorted(calls)
    out['imports']=sorted(imports)
    out['classes']=sorted(set(out['classes']))
    out['effects']=sorted(effects)
    return out

items=json.load(sys.stdin)
json.dump([analyze(x) for x in items],sys.stdout)
`;

function emptyFacts(error?: string): SemanticFacts {
  return { defines: [], reads: [], calls: [], imports: [], functions: [], classes: [], effects: [], dynamic: false, ...(error ? { parseError: error } : {}) };
}

async function analyzePython(codes: string[]): Promise<SemanticFacts[]> {
  return new Promise(resolve => {
    const child = spawn("python3", ["-c", PY_ANALYZER], { stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "", stderr = "", done = false;
    const finish = (facts: SemanticFacts[]) => { if (!done) { done = true; clearTimeout(timer); resolve(facts); } };
    const timer = setTimeout(() => { try { child.kill("SIGKILL"); } catch {} finish(codes.map(() => emptyFacts("Python AST analysis timed out"))); }, 30000);
    child.stdout.on("data", d => stdout += d);
    child.stderr.on("data", d => stderr += d);
    child.on("error", e => finish(codes.map(() => emptyFacts(String(e)))));
    child.on("close", () => {
      try {
        const raw = JSON.parse(stdout);
        finish(raw.map((x: any) => ({ ...emptyFacts(), ...x })));
      } catch { finish(codes.map(() => emptyFacts(stderr || "Invalid Python AST analysis response"))); }
    });
    child.stdin.end(JSON.stringify(codes));
  });
}

function analyzeBash(code: string): SemanticFacts {
  const defines = new Set<string>();
  const reads = new Set<string>();
  const calls = new Set<string>();
  const imports = new Set<string>();
  const effects = new Set<Effect>();
  const functions: SemanticFacts["functions"] = [];
  let dynamic = false;
  for (const line of code.split("\n")) {
    const fn = /^\s*(?:function\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*(?:\(\))?\s*\{/.exec(line);
    if (fn) { defines.add(fn[1]); functions.push({ name: fn[1], parameters: [], requiredParameters: 0, async: false }); }
    const assign = /^\s*([A-Za-z_][A-Za-z0-9_]*)=/.exec(line);
    if (assign) defines.add(assign[1]);
    for (const m of line.matchAll(/\$\{?([A-Za-z_][A-Za-z0-9_]*)\}?/g)) reads.add(m[1]);
    const call = /^\s*([A-Za-z_./-][A-Za-z0-9_./-]*)\b/.exec(line.replace(/^\s*(if|then|elif|while|until|do)\s+/, ""));
    if (call && !/^(for|case|function|return|local|export|readonly)$/.test(call[1])) calls.add(call[1]);
    const source = /^\s*(?:source|\.)\s+([^\s]+)/.exec(line);
    if (source) imports.add(source[1]);
    if (/\b(curl|wget|ssh|nc|socat)\b/.test(line)) effects.add("uses_network");
    if (/\b(rm|rmdir|unlink|shred)\b/.test(line)) effects.add("deletes_data");
    if (/\b(cat|head|tail|grep|awk|sed)\b.*[<]|[<]\s*[^<]/.test(line)) effects.add("reads_files");
    if (/(^|[^>])>{1,2}[^>]|\b(tee|cp|mv|touch|mkdir)\b/.test(line)) effects.add("writes_files");
    if (/\b(eval|declare\s+-n|source\s+\$|\.\s+\$)\b/.test(line)) { dynamic = true; effects.add("unknown_dynamic"); }
    if (/\b(mysql|psql|sqlite3)\b/.test(line)) effects.add("writes_database");
  }
  return { defines: [...defines].sort(), reads: [...reads].sort(), calls: [...calls].sort(), imports: [...imports].sort(), functions, classes: [], effects: [...effects].sort(), dynamic };
}

function analyzeR(code: string): SemanticFacts {
  const defines = new Set<string>();
  const reads = new Set<string>();
  const calls = new Set<string>();
  const imports = new Set<string>();
  const effects = new Set<Effect>();
  const functions: SemanticFacts["functions"] = [];
  // assignments: x <- ...  / x <<- ... / assign("x", ...)
  for (const m of code.matchAll(/([A-Za-z.][\w.]*)\s*(<-|<<-)/g)) defines.add(m[1]);
  for (const m of code.matchAll(/assign\(\s*["']([\w.]+)["']/g)) defines.add(m[1]);
  // function definitions: name <- function(a, b = 1, ...)
  for (const m of code.matchAll(/([A-Za-z.][\w.]*)\s*<\-\s*function\s*\(([^)]*)\)/g)) {
    defines.add(m[1]);
    const params = m[2].split(",").map(p => p.trim().split(/\s*=/)[0].trim()).filter(p => /^[\w.]+$/.test(p));
    functions.push({ name: m[1], parameters: params, requiredParameters: params.filter(p => !m[2].includes(p + " =") && !m[2].includes(p + "=")).length, async: false });
  }
  for (const m of code.matchAll(/\bfunction\s*\(([^)]*)\)/g)) {
    if (!functions.length || !code.match(new RegExp("[A-Za-z.][\\w.]*\\s*<-\\s*function"))) { /* anonymous */ }
  }
  // calls and reads
  for (const m of code.matchAll(/([A-Za-z.][\w.]*)\s*\(/g)) calls.add(m[1]);
  for (const m of code.matchAll(/([A-Za-z.][\w.]*)\$/g)) calls.add(m[1]);
  // library/require
  for (const m of code.matchAll(/\b(?:library|require)\s*\(\s*["']?([\w.]+)/g)) imports.add(m[1]);
  // effects
  for (const m of code.matchAll(/\b(read\.csv|read\.csv2|read\.table|readLines|readRDS|source|file\.exists|list\.files|dir)\s*\(/g)) effects.add("reads_files");
  for (const m of code.matchAll(/\b(write\.csv|write\.csv2|write\.table|writeLines|saveRDS|save|png|pdf|jpeg|ggsave)\s*\(/g)) effects.add("writes_files");
  for (const m of code.matchAll(/\b(unlink|file\.remove)\s*\(/g)) effects.add("deletes_data");
  for (const m of code.matchAll(/\b(system|system2)\s*\(/g)) effects.add("starts_process");
  for (const m of code.matchAll(/\binstall\.packages\s*\(/g)) { effects.add("uses_network"); effects.add("starts_process"); }
  for (const m of code.matchAll(/\b(dbConnect|dbGetQuery|dbExecute|dbWriteTable)\s*\(/g)) effects.add("reads_database");
  for (const m of code.matchAll(/\b(Sys\.time|Sys\.Date|as\.Date\s*\(\s*Sys|format\s*\(\s*Sys)\b/g)) effects.add("uses_time");
  for (const m of code.matchAll(/\b(rnorm|runif|sample|set\.seed)\s*\(/g)) effects.add("uses_randomness");
  for (const m of code.matchAll(/\b(eval|get|do\.call|parse\s*\(\s*text)\s*\(/g)) effects.add("unknown_dynamic");
  // reads: identifiers not assigned locally and not a call name
  for (const m of code.matchAll(/\b([A-Za-z.][\w.]*)\b/g)) {
    const name = m[1];
    if (!defines.has(name) && !calls.has(name) && !imports.has(name) && !/^(T|F|TRUE|FALSE|NA|NULL|Inf|NaN|if|else|for|while|repeat|function|in|next|break|return|library|require|c|list|data\.frame|matrix)$/.test(name)) reads.add(name);
  }
  return {
    defines: [...defines].sort(), reads: [...reads].sort(), calls: [...calls].sort(),
    imports: [...imports].sort(), functions, classes: [],
    effects: [...effects].sort(), dynamic: effects.has("unknown_dynamic"),
  };
}

export async function analyzeBlocks(target: Target, codes: string[]): Promise<SemanticFacts[]> {
  if (target === "python") return analyzePython(codes);
  if (target === "r") return codes.map(analyzeR);
  return codes.map(analyzeBash);
}

function interfaceHash(f: SemanticFacts): string {
  return sha(JSON.stringify({ defines: f.defines, functions: f.functions, classes: f.classes, effects: f.effects })).slice(0, 24);
}

export interface GraphInput { unit: Unit; code: string; nodeId: string; ordinal: number }

// Preserve node IDs across edits. Exact statements match first. Remaining
// statements match by ordinal, which lets one edited statement retain its
// dependency identity.
export function assignNodeIds(units: Unit[], previous?: DependencyGraph): string[] {
  const prev = previous?.nodes ?? [];
  const used = new Set<string>();
  const ids = new Array<string>(units.length);
  for (let i = 0; i < units.length; i++) {
    const key = stmtKey(units[i].text);
    const candidates = prev.filter(n => n.stmtKey === key && !used.has(n.id));
    if (candidates.length) {
      candidates.sort((a, b) => Math.abs(a.ordinal - i) - Math.abs(b.ordinal - i));
      ids[i] = candidates[0].id; used.add(ids[i]);
    }
  }
  for (let i = 0; i < units.length; i++) {
    if (ids[i]) continue;
    const old = prev.find(n => n.ordinal === i && !used.has(n.id));
    if (old) { ids[i] = old.id; used.add(old.id); }
    else ids[i] = `n-${sha(`${stmtKey(units[i].text)}:${i}:${Date.now()}`).slice(0, 16)}`;
  }
  return ids;
}

export async function buildDependencyGraph(
  target: Target,
  engine: string,
  briefsHash: string,
  sourceText: string,
  inputs: GraphInput[],
): Promise<DependencyGraph> {
  const facts = await analyzeBlocks(target, inputs.map(x => x.code));
  const nodes: GraphNode[] = inputs.map((x, i) => ({
    id: x.nodeId, ordinal: x.ordinal, stmtKey: stmtKey(x.unit.text), stmt: x.unit.text,
    startLine: x.unit.startLine, endLine: x.unit.endLine,
    sourceHash: sha(x.unit.text.trim()).slice(0, 24),
    implementationHash: sha(x.code.trim()).slice(0, 24),
    interfaceHash: interfaceHash(facts[i]), facts: facts[i], dependencies: [], dependencyInterfaceHash: "",
  }));

  // Function and class declarations hoist. Other definitions use the latest
  // preceding provider, like normal execution.
  const hoisted = new Map<string, GraphNode>();
  for (const n of nodes) {
    for (const f of n.facts.functions) hoisted.set(f.name, n);
    for (const c of n.facts.classes) hoisted.set(c, n);
  }
  const latest = new Map<string, GraphNode>();
  let priorEffect: GraphNode | undefined;
  for (const n of nodes) {
    const grouped = new Map<string, string[]>();
    for (const symbol of n.facts.reads) {
      const p = latest.get(symbol) ?? hoisted.get(symbol);
      if (p && p.id !== n.id) grouped.set(p.id, [...(grouped.get(p.id) ?? []), symbol]);
    }
    for (const [nodeId, symbols] of grouped) n.dependencies.push({ nodeId, symbols: [...new Set(symbols)].sort(), kind: "symbol" });
    if (n.facts.dynamic) {
      for (const p of nodes.slice(0, n.ordinal)) {
        if (!n.dependencies.some(d => d.nodeId === p.id)) n.dependencies.push({ nodeId: p.id, symbols: [], kind: "dynamic" });
      }
    }
    if (n.facts.effects.length && priorEffect && !n.dependencies.some(d => d.nodeId === priorEffect!.id)) {
      n.dependencies.push({ nodeId: priorEffect.id, symbols: [], kind: "effect" });
    }
    if (n.facts.effects.length) priorEffect = n;
    for (const symbol of n.facts.defines) latest.set(symbol, n);
  }
  const byId = new Map(nodes.map(n => [n.id, n]));
  for (const n of nodes) {
    const parts = n.dependencies
      .map(d => `${d.nodeId}:${byId.get(d.nodeId)?.interfaceHash ?? "missing"}:${d.kind}`)
      .sort();
    n.dependencyInterfaceHash = sha(parts.join("\n")).slice(0, 24);
  }
  return { version: 1, target, engineId: engine, briefsHash, sourceHash: sha(sourceText).slice(0, 24), builtAt: Date.now(), nodes };
}

export function dependencyMap(node: GraphNode, graph: DependencyGraph): Record<string, string> {
  const byId = new Map(graph.nodes.map(n => [n.id, n]));
  return Object.fromEntries(node.dependencies.map(d => [d.nodeId, byId.get(d.nodeId)?.interfaceHash ?? "missing"]));
}

export function changedDependencies(accepted: Record<string, string> | undefined, node: GraphNode, graph: DependencyGraph): string[] {
  if (!accepted) return [];
  const current = dependencyMap(node, graph);
  const all = new Set([...Object.keys(accepted), ...Object.keys(current)]);
  const byId = new Map(graph.nodes.map(n => [n.id, n]));
  return [...all].filter(id => accepted[id] !== current[id]).map(id => {
    const provider = byId.get(id);
    return provider?.facts.defines.join(", ") || provider?.stmt.split("\n")[0] || id;
  });
}

export function transitiveDependents(graph: DependencyGraph, roots: Set<string>): Set<string> {
  const out = new Set<string>();
  let changed = true;
  while (changed) {
    changed = false;
    for (const n of graph.nodes) {
      if (roots.has(n.id) || out.has(n.id)) continue;
      if (n.dependencies.some(d => roots.has(d.nodeId) || out.has(d.nodeId))) { out.add(n.id); changed = true; }
    }
  }
  return out;
}
