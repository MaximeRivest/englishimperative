import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { EngineConfig, Target } from "./types";
import { piBriefForDir } from "./engine";

// Shares the cache directory and format with the ei CLI (~/.ei/libs):
// first line "<!-- fingerprint -->", then the brief text.
export function libDir(): string {
  return process.env.EI_LIB_DIR || path.join(os.homedir(), ".ei", "libs");
}

export function expandHome(p: string): string {
  return p.startsWith("~") ? path.join(os.homedir(), p.slice(1)) : p;
}

function sha(s: string): string {
  return createHash("sha256").update(s).digest("hex");
}

function listSourceFiles(root: string, maxFiles: number): string[] {
  const exts = new Set([".py", ".sh", ".R", ".r"]);
  const found: string[] = [];
  const walk = (dir: string, depth: number) => {
    if (depth > 3 || found.length >= maxFiles) return;
    let entries: fs.Dirent[] = [];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (found.length >= maxFiles) return;
      const full = path.join(dir, e.name);
      if (e.isDirectory() && !e.name.startsWith(".") && e.name !== "node_modules" && e.name !== "__pycache__") walk(full, depth + 1);
      else if (e.isFile() && exts.has(path.extname(e.name))) found.push(full);
    }
  };
  walk(root, 0);
  return found;
}

export function fingerprint(p: string): string {
  try {
    if (fs.statSync(p).isDirectory()) {
      try {
        return execFileSync("git", ["-C", p, "rev-parse", "HEAD"], { timeout: 10000, stdio: ["ignore", "pipe", "pipe"] }).toString().trim();
      } catch { /* not a git repo */ }
    }
  } catch { return "missing"; }
  const stat = (f: string) => { try { const s = fs.statSync(f); return `${f} ${s.mtimeMs}`; } catch { return f; } };
  const files = fs.statSync(p).isDirectory() ? listSourceFiles(p, 400) : [p];
  return sha(files.map(stat).join("\n")).slice(0, 16);
}

const SIG_RE = /^(def |class |function |[A-Za-z_][A-Za-z0-9_.]* *(<-|=) *function)|^[A-Za-z_][A-Za-z0-9_]*\(\)/;

export function grepBrief(p: string): string {
  const files = fs.statSync(p).isDirectory() ? listSourceFiles(p, 40) : [p];
  const out: string[] = [];
  for (const f of files) {
    out.push(`## ${f}`);
    let text = "";
    try { text = fs.readFileSync(f, "utf8"); } catch { continue; }
    const lines = text.split("\n");
    let count = 0;
    for (let i = 0; i < lines.length && count < 40; i++) {
      if (SIG_RE.test(lines[i])) { out.push(`${i + 1}:${lines[i]}`); count++; }
    }
    if (out.length > 300) break;
  }
  return out.slice(0, 300).join("\n");
}

// Cached brief for one library path (file or repo).
export async function briefFor(rawPath: string, cfg: EngineConfig, force = false): Promise<string> {
  const p = expandHome(rawPath);
  if (!fs.existsSync(p)) return `(library not found: ${rawPath})`;
  const dir = libDir();
  fs.mkdirSync(dir, { recursive: true });
  // matches the ei CLI key: realpath | sha256sum (the pipe adds "\n")
  const key = sha(fs.realpathSync(p) + "\n").slice(0, 16);
  const cache = path.join(dir, `${key}.md`);
  const fp = fingerprint(p);
  if (!force && fs.existsSync(cache)) {
    const text = fs.readFileSync(cache, "utf8");
    const nl = text.indexOf("\n");
    if (text.slice(0, nl) === `<!-- ${fp} -->`) return text.slice(nl + 1).trimEnd();
  }
  let brief = "";
  if (fs.statSync(p).isDirectory() && cfg.engine === "pi") {
    try { brief = await piBriefForDir(p, cfg); } catch { brief = ""; }
  }
  if (!brief) brief = grepBrief(p);
  fs.writeFileSync(cache, `<!-- ${fp} -->\n${brief}\n`);
  return brief;
}

// Synchronous read of an existing brief (for cheap staleness checks).
// Returns "" when the cache is absent or the fingerprint changed.
export function cachedBriefText(rawPath: string): string {
  try {
    const p = expandHome(rawPath);
    if (!fs.existsSync(p)) return `(library not found: ${rawPath})`;
    const cache = path.join(libDir(), createHash("sha256").update(fs.realpathSync(p) + "\n").digest("hex").slice(0, 16) + ".md");
    if (!fs.existsSync(cache)) return "";
    const text = fs.readFileSync(cache, "utf8");
    const nl = text.indexOf("\n");
    if (text.slice(0, nl) !== `<!-- ${fingerprint(p)} -->`) return "";
    return text.slice(nl + 1).trimEnd();
  } catch { return ""; }
}

// Deterministic library-loading code: the compiler, not the model, makes
// libraries available.
export function preludeFor(target: Target, rawPath: string): string {
  const p = expandHome(rawPath);
  if (!fs.existsSync(p)) return "";
  const isDir = fs.statSync(p).isDirectory();
  if (target === "python") {
    // data files (csv, json, …) are context for the model, not imports
    if (!isDir && !p.endsWith(".py")) return "";
    const dir = isDir ? p : path.dirname(p);
    let out = `sys.path.insert(0, '${dir}')\n`;
    const mods = isDir
      ? fs.readdirSync(p).filter(f => f.endsWith(".py") && !f.startsWith("__")).sort().slice(0, 8)
      : [path.basename(p)];
    for (const m of mods) out += `import ${m.replace(/\.py$/, "")}\n`;
    return out;
  }
  if (target === "r") {
    const rfiles = isDir
      ? fs.readdirSync(p).filter(f => /\.[Rr]$/.test(f)).sort().slice(0, 8).map(f => path.join(p, f))
      : /\.[Rr]$/.test(p) ? [p] : [];
    return rfiles.map(f => `source('${f}')\n`).join("");
  }
  if (!isDir) return p.endsWith(".sh") ? `source '${p}'\n` : "";
  const shs = fs.readdirSync(p).filter(f => f.endsWith(".sh")).sort().slice(0, 8);
  return shs.map(f => `source '${path.join(p, f)}'\n`).join("");
}
