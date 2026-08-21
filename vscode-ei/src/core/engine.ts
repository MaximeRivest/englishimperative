import { ChildProcess, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { EngineConfig } from "./types";

export function stripFences(s: string): string {
  return s.split("\n").filter(l => !/^```/.test(l)).join("\n").trim();
}

// stdin must be closed: `pi -p` blocks on an open stdin pipe when it is
// not a TTY.
function execP(cmd: string, args: string[], timeoutMs: number): Promise<{ stdout: string; stderr: string; code: number }> {
  return new Promise(resolve => {
    const child = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "", stderr = "", done = false;
    const finish = (code: number) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve({ stdout, stderr, code });
    };
    const timer = setTimeout(() => { try { child.kill("SIGKILL"); } catch { /* gone */ } finish(124); }, timeoutMs);
    child.stdout.on("data", d => { stdout += d; });
    child.stderr.on("data", d => { stderr += d; });
    child.on("error", e => { stderr += String(e); finish(127); });
    child.on("close", code => finish(code ?? 1));
  });
}

async function llmHttp(sys: string, user: string, maxTokens: number, cfg: EngineConfig): Promise<string> {
  const res = await fetch(cfg.httpUrl, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${cfg.httpApiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: cfg.httpModel,
      temperature: 0,
      max_tokens: maxTokens,
      messages: [
        { role: "system", content: sys },
        { role: "user", content: user },
      ],
    }),
    signal: AbortSignal.timeout(120000),
  });
  if (!res.ok) throw new Error(`http engine: ${res.status} ${await res.text().catch(() => "")}`.trim());
  const data: any = await res.json();
  return String(data?.choices?.[0]?.message?.content ?? "");
}

// ---------------------------------------------------------- warm pi RPC
// One persistent `pi --mode rpc` process per model/mode pair. Each model
// call is a prompt; the answer is the final assistant message before
// agent_settled. The varying task prompt travels inside the user message;
// the ei prompt mode supplies the fixed interpreter role.
interface Waiter { test: (e: any) => boolean; resolve: (e: any) => void; reject: (err: Error) => void }

class PiRpc {
  private child: ChildProcess;
  private buffer = "";
  private waiters: Waiter[] = [];
  private stderrTail = "";
  private lastAssistantText = "";
  alive = true;
  busy = Promise.resolve();
  prompts = 0;

  constructor(cfg: EngineConfig) {
    const args = ["--mode", "rpc", "--no-session", "--no-skills", "--no-context-files", "--no-tools", "--thinking", "off"];
    if (cfg.piModel) args.push("--model", cfg.piModel);
    if (cfg.piModeFile) args.push("--prompt-mode-file", cfg.piModeFile);
    this.child = spawn("pi", args, { stdio: ["pipe", "pipe", "pipe"] });
    this.child.stderr!.on("data", d => { this.stderrTail = (this.stderrTail + d).slice(-800); });
    this.child.on("error", e => this.fail(new Error(String(e))));
    this.child.on("exit", code => this.fail(new Error(`pi rpc exited (code ${code}). ${this.stderrTail.trim().split("\n").slice(-2).join(" ")}`)));
    this.child.stdout!.on("data", chunk => {
      this.buffer += chunk;
      let nl;
      while ((nl = this.buffer.indexOf("\n")) >= 0) {
        const line = this.buffer.slice(0, nl).replace(/\r$/, "");
        this.buffer = this.buffer.slice(nl + 1);
        if (!line.trim()) continue;
        let event: any; try { event = JSON.parse(line); } catch { continue; }
        if (event.type === "message_end" && event.message?.role === "assistant") {
          const text = (event.message.content ?? []).filter((c: any) => c?.type === "text").map((c: any) => c.text).join("\n").trim();
          if (text) this.lastAssistantText = text;
        }
        const i = this.waiters.findIndex(w => w.test(event));
        if (i >= 0) this.waiters.splice(i, 1)[0].resolve(event);
      }
    });
  }

  private fail(err: Error) {
    this.alive = false;
    for (const w of this.waiters.splice(0)) { try { w.reject(err); } catch {} }
  }

  kill() { this.alive = false; try { this.child.kill("SIGTERM"); } catch {} }

  private waitFor(test: (e: any) => boolean, timeoutMs: number): Promise<any> {
    return new Promise((resolve, reject) => {
      const waiter: Waiter = { test, resolve: e => { clearTimeout(timer); resolve(e); }, reject: e => { clearTimeout(timer); reject(e); } };
      const timer = setTimeout(() => {
        const i = this.waiters.indexOf(waiter);
        if (i >= 0) this.waiters.splice(i, 1);
        reject(new Error("pi rpc timed out"));
      }, timeoutMs);
      this.waiters.push(waiter);
    });
  }

  private request(cmd: Record<string, unknown>, timeoutMs: number): Promise<any> {
    if (!this.alive) return Promise.reject(new Error("pi rpc process is gone"));
    const id = randomUUID();
    const matched = this.waitFor(e => e.type === "response" && e.id === id, timeoutMs);
    this.child.stdin!.write(JSON.stringify({ id, ...cmd }) + "\n");
    return matched.then(response => {
      if (!response.success) throw new Error(response.error || "pi rpc request failed");
      return response;
    });
  }

  async ready(timeoutMs = 30000): Promise<void> {
    const t0 = Date.now();
    for (;;) {
      try { await this.request({ type: "get_state" }, 5000); return; }
      catch (e) {
        if (!this.alive || Date.now() - t0 > timeoutMs) throw e instanceof Error ? e : new Error(String(e));
        await new Promise(r => setTimeout(r, 300));
      }
    }
  }

  prompt(message: string, timeoutMs = 180000): Promise<string> {
    const run = this.busy.catch(() => {}).then(async () => {
      if (!this.alive) throw new Error("pi rpc process is gone");
      this.prompts++;
      this.lastAssistantText = "";
      const settled = this.waitFor(e => e.type === "agent_settled", timeoutMs);
      await this.request({ type: "prompt", message }, 30000);
      await settled;
      const text = this.lastAssistantText.trim();
      if (!text) throw new Error(`pi rpc returned no text. ${this.stderrTail.trim().split("\n").slice(-2).join(" ")}`);
      return text;
    });
    this.busy = run.then(() => {}, () => {});
    return run;
  }
}

const warmSessions = new Map<string, { session: PiRpc; idle?: NodeJS.Timeout }>();
const WARM_IDLE_MS = 3 * 60 * 1000;
const WARM_MAX_PROMPTS = 12; // recycle so conversation context stays small

function warmKey(cfg: EngineConfig): string { return `${cfg.piModel}|${cfg.piModeFile}`; }

async function getWarm(cfg: EngineConfig): Promise<PiRpc> {
  const key = warmKey(cfg);
  const existing = warmSessions.get(key);
  if (existing?.session.alive && existing.session.prompts < WARM_MAX_PROMPTS) return existing.session;
  if (existing) { existing.session.kill(); warmSessions.delete(key); }
  const session = new PiRpc(cfg);
  await session.ready();
  warmSessions.set(key, { session });
  return session;
}

function armIdle(cfg: EngineConfig) {
  const entry = warmSessions.get(warmKey(cfg));
  if (!entry) return;
  clearTimeout(entry.idle);
  entry.idle = setTimeout(() => { entry.session.kill(); warmSessions.delete(warmKey(cfg)); }, WARM_IDLE_MS);
  entry.idle.unref?.();
}

export function shutdownWarmPi(): void {
  for (const [key, entry] of warmSessions) { clearTimeout(entry.idle); entry.session.kill(); warmSessions.delete(key); }
}

async function llmPiOneShot(sys: string, user: string, cfg: EngineConfig): Promise<string> {
  const args = ["-p", "--no-session", "--no-skills", "--no-context-files", "--no-tools", "--thinking", "off"];
  if (cfg.piModel) args.push("--model", cfg.piModel);
  if (cfg.piModeFile) args.push("--prompt-mode-file", cfg.piModeFile);
  args.push("--append-system-prompt", sys, user);
  let lastErr = "";
  for (let attempt = 1; attempt <= 3; attempt++) {
    const r = await execP("pi", args, 180000);
    const out = r.stdout.trim();
    if (out) return out;
    lastErr = r.stderr.trim().split("\n").slice(-3).join(" ") || `pi exited with code ${r.code}`;
    // Anthropic refusals are deterministic; do not retry them.
    if (/refused this request/i.test(lastErr)) break;
    if (attempt < 3) await new Promise(r2 => setTimeout(r2, attempt * 2000));
  }
  throw new Error(`pi engine: ${lastErr || "empty response"}`);
}

async function llmPi(sys: string, user: string, cfg: EngineConfig): Promise<string> {
  if (process.env.EI_NO_WARM_PI !== "1") {
    try {
      const session = await getWarm(cfg);
      const out = await session.prompt(`${sys}\n\n----\n\n${user}`);
      armIdle(cfg);
      return out;
    } catch {
      shutdownWarmPi(); // fall back to one-shot below
    }
  }
  return llmPiOneShot(sys, user, cfg);
}

// One model call. Returns the answer with fences stripped.
export async function llm(sys: string, user: string, maxTokens: number, cfg: EngineConfig): Promise<string> {
  const raw = cfg.engine === "pi" ? await llmPi(sys, user, cfg) : await llmHttp(sys, user, maxTokens, cfg);
  return stripFences(raw);
}

// Model identity used in cache keys, so switching engines invalidates entries.
export function engineId(cfg: EngineConfig): string {
  return cfg.engine === "pi" ? `pi:${cfg.piModel || "default"}` : `http:${cfg.httpModel}`;
}

export async function piBriefForDir(dir: string, cfg: EngineConfig): Promise<string> {
  const args = ["-p", "--no-session", "--no-skills", "--no-context-files", "--thinking", "off", "--tools", "read,bash"];
  if (cfg.piModel) args.push("--model", cfg.piModel);
  args.push(
    "--append-system-prompt",
    "You document a code library for a code generator. Inspect the files (read-only: list, read, grep; change nothing). Output plain markdown only: the public functions with signatures, one line of purpose each, and one short usage example.",
    `Document the library at: ${dir}`,
  );
  const r = await execP("pi", args, 300000);
  return stripFences(r.stdout);
}
