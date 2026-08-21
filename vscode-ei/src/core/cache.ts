import { createHash } from "node:crypto";
import * as fs from "node:fs";
import { isSourceFile, stripSourceExt } from "./language";
import { CacheData, PinData } from "./types";

export function sha(s: string): string {
  return createHash("sha256").update(s).digest("hex");
}

export function cachePath(eiFile: string): string {
  return (isSourceFile(eiFile) ? stripSourceExt(eiFile) : eiFile) + ".eic.json";
}

export function stmtKey(stmt: string): string {
  return sha(stmt.trim()).slice(0, 24);
}

function empty(): CacheData {
  return { version: 2, translations: {}, pins: {} };
}

export function loadCache(eiFile: string): CacheData {
  try {
    const raw: any = JSON.parse(fs.readFileSync(cachePath(eiFile), "utf8"));
    if (!raw || typeof raw !== "object") return empty();
    if (raw.version === 2) return { ...empty(), ...raw };
    // v1 migration: old explicit pins stay valid. Semantic metadata is added
    // on the next compile.
    if (raw.version === 1) {
      const pins: Record<string, PinData> = {};
      for (const [key, value] of Object.entries(raw.pins ?? {}) as [string, any][]) {
        pins[key] = { code: String(value.code ?? ""), stmt: String(value.stmt ?? ""), at: Number(value.at ?? Date.now()), automatic: false };
      }
      return {
        version: 2,
        translations: raw.translations ?? {},
        pins,
        survey: raw.survey,
      };
    }
  } catch { /* fresh */ }
  return empty();
}

export function saveCache(eiFile: string, cache: CacheData): void {
  const entries = Object.entries(cache.translations);
  if (entries.length > 600) {
    entries.sort((a, b) => b[1].at - a[1].at);
    cache.translations = Object.fromEntries(entries.slice(0, 400));
  }
  cache.version = 2;
  fs.writeFileSync(cachePath(eiFile), JSON.stringify(cache, null, 1) + "\n");
}
