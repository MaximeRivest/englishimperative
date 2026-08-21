// Source files may be written in any human language. The file extension may
// name the language: a full name (report.english, rapport.francais), an
// ISO 639-1/639-2 code (rapport.fr, rapport.fra), or a combined form
// (rapport.fr.ei). Plain .ei works for every language: the survey detects it.
// This table maps extensions only. It never constrains wording.

interface LanguageDef { code2: string; code3: string[]; names: string[]; english: string }

const LANGS: LanguageDef[] = [
  { code2: "en", code3: ["eng"], names: ["english"], english: "English" },
  { code2: "fr", code3: ["fra", "fre"], names: ["french", "francais", "français"], english: "French" },
  { code2: "es", code3: ["spa"], names: ["spanish", "espanol", "español", "castellano"], english: "Spanish" },
  { code2: "de", code3: ["deu", "ger"], names: ["german", "deutsch"], english: "German" },
  { code2: "it", code3: ["ita"], names: ["italian", "italiano"], english: "Italian" },
  { code2: "pt", code3: ["por"], names: ["portuguese", "portugues", "português"], english: "Portuguese" },
  { code2: "nl", code3: ["nld", "dut"], names: ["dutch", "nederlands"], english: "Dutch" },
  { code2: "sv", code3: ["swe"], names: ["swedish", "svenska"], english: "Swedish" },
  { code2: "da", code3: ["dan"], names: ["danish", "dansk"], english: "Danish" },
  { code2: "no", code3: ["nor", "nob", "nno"], names: ["norwegian", "norsk"], english: "Norwegian" },
  { code2: "fi", code3: ["fin"], names: ["finnish", "suomi"], english: "Finnish" },
  { code2: "pl", code3: ["pol"], names: ["polish", "polski"], english: "Polish" },
  { code2: "cs", code3: ["ces", "cze"], names: ["czech", "cestina", "čeština"], english: "Czech" },
  { code2: "sk", code3: ["slk", "slo"], names: ["slovak"], english: "Slovak" },
  { code2: "ru", code3: ["rus"], names: ["russian"], english: "Russian" },
  { code2: "uk", code3: ["ukr"], names: ["ukrainian"], english: "Ukrainian" },
  { code2: "el", code3: ["ell", "gre"], names: ["greek"], english: "Greek" },
  { code2: "tr", code3: ["tur"], names: ["turkish", "turkce", "türkçe"], english: "Turkish" },
  { code2: "ar", code3: ["ara"], names: ["arabic"], english: "Arabic" },
  { code2: "he", code3: ["heb"], names: ["hebrew"], english: "Hebrew" },
  { code2: "fa", code3: ["fas", "per"], names: ["persian", "farsi"], english: "Persian" },
  { code2: "hi", code3: ["hin"], names: ["hindi"], english: "Hindi" },
  { code2: "bn", code3: ["ben"], names: ["bengali"], english: "Bengali" },
  { code2: "ja", code3: ["jpn"], names: ["japanese", "nihongo"], english: "Japanese" },
  { code2: "ko", code3: ["kor"], names: ["korean"], english: "Korean" },
  { code2: "zh", code3: ["zho", "chi"], names: ["chinese", "zhongwen"], english: "Chinese" },
  { code2: "vi", code3: ["vie"], names: ["vietnamese"], english: "Vietnamese" },
  { code2: "th", code3: ["tha"], names: ["thai"], english: "Thai" },
  { code2: "ro", code3: ["ron", "rum"], names: ["romanian"], english: "Romanian" },
  { code2: "hu", code3: ["hun"], names: ["hungarian", "magyar"], english: "Hungarian" },
  { code2: "ca", code3: ["cat"], names: ["catalan", "català"], english: "Catalan" },
  { code2: "id", code3: ["ind"], names: ["indonesian"], english: "Indonesian" },
  { code2: "sw", code3: ["swa"], names: ["swahili"], english: "Swahili" },
];

const byToken = new Map<string, LanguageDef>();
for (const l of LANGS) {
  byToken.set(l.code2, l);
  for (const c of l.code3) byToken.set(c, l);
  for (const n of l.names) byToken.set(n, l);
}

function extTokens(file: string): string[] {
  const base = file.split("/").pop() ?? file;
  return base.toLowerCase().split(".").slice(1);
}

// English name of the language named by the extension, or null (auto-detect).
export function languageOfFile(file: string): string | null {
  const tokens = extTokens(file);
  if (!tokens.length) return null;
  const last = tokens[tokens.length - 1];
  if (last === "ei") {
    const before = tokens[tokens.length - 2];
    return before ? byToken.get(before)?.english ?? null : null;
  }
  return byToken.get(last)?.english ?? null;
}

// Is this file a natural-language source file?
export function isSourceFile(file: string): boolean {
  const tokens = extTokens(file);
  if (!tokens.length) return false;
  const last = tokens[tokens.length - 1];
  return last === "ei" || byToken.has(last);
}

// rapport.fr.ei -> rapport; rapport.francais -> rapport; report.ei -> report
export function stripSourceExt(file: string): string {
  if (!isSourceFile(file)) return file;
  let out = file.replace(/\.[^./]+$/, "");
  const tokens = extTokens(out);
  if (tokens.length && byToken.has(tokens[tokens.length - 1]) && /\.ei$/i.test(file)) {
    out = out.replace(/\.[^./]+$/, "");
  }
  return out;
}

export function englishNameOfCode(code: string): string | null {
  return byToken.get(code.trim().toLowerCase())?.english ?? null;
}

// Extensions the VS Code manifest should claim. Full names are safe; a few
// ISO codes collide with programming languages (.pl Perl, .ml OCaml, .es
// modules) and stay out; those files still work through the CLI.
export const SAFE_ISO_CODES = LANGS.map(l => l.code2).filter(c => !["pl", "ml", "es", "no", "sh"].includes(c));
export const FULL_NAMES = LANGS.flatMap(l => l.names.filter(n => /^[a-z]+$/.test(n)));
