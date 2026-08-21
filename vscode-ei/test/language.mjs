// Any-human-language sources: extension mapping + a real French program.
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { languageOfFile, isSourceFile, stripSourceExt } from "../out/core/language.js";
import { cachePath } from "../out/core/cache.js";
import { compile } from "../out/core/compiler.js";

const cfg = {
  engine: "http",
  httpUrl: "http://192.168.2.24:8000/v1/chat/completions",
  httpApiKey: "inktype-local",
  httpModel: "qwen/qwen3.8-27b",
  piModel: "", piModeFile: "",
};
let failures = 0;
const check = (name, ok, extra = "") => { console.log(`${ok ? "PASS" : "FAIL"}  ${name}${extra ? "  — " + extra : ""}`); if (!ok) failures++; };

// -------------------------------------------------- extension mapping
check("map: full name", languageOfFile("rapport.francais") === "French");
check("map: native name", languageOfFile("bericht.deutsch") === "German");
check("map: iso 639-1", languageOfFile("rapport.fr") === "French");
check("map: iso 639-2", languageOfFile("informe.spa") === "Spanish");
check("map: combined", languageOfFile("rapport.fr.ei") === "French");
check("map: plain .ei is auto", languageOfFile("report.ei") === null);
check("map: unknown ext is not source", !isSourceFile("data.csv"));
check("map: iso is source", isSourceFile("x.fr"));
check("strip: combined", stripSourceExt("/a/rapport.fr.ei") === "/a/rapport");
check("strip: full name", stripSourceExt("rapport.francais") === "rapport");
check("cache: sidecar next to french file", cachePath("/a/rapport.francais") === "/a/rapport.eic.json");

// -------------------------------------------------- a real French program
const dir = "/tmp/eitest-lang";
fs.rmSync(dir, { recursive: true, force: true });
fs.mkdirSync(dir, { recursive: true });
const f = path.join(dir, "salutations.francais");
fs.writeFileSync(f, `Ce petit programme est écrit en Python.

Pour saluer quelqu'un:
    renvoyer "Bonjour, " suivi du nom de la personne et d'un point d'exclamation

Affiche la salutation pour "Maxime".

Par exemple, saluer "Ada" doit donner exactement "Bonjour, Ada!".
`);
console.log("french: compiling…");
const r = await compile(f, fs.readFileSync(f, "utf8"), cfg, { translateMissing: true, lint: false, onProgress: m => console.log("  …", m) });
check("french: target inferred", r.target === "python");
check("french: definition found", r.survey.definitions.length === 1, JSON.stringify(r.survey.definitions));
check("french: example found", r.survey.examples.length === 1, JSON.stringify(r.survey.examples));
check("french: no errors", !r.diagnostics.some(d => d.severity === "error"), JSON.stringify(r.diagnostics));
const out = execFileSync("python3", ["-c", r.script], { timeout: 30000 }).toString();
check("french: program runs", out.includes("Bonjour, Maxime!"), out.trim());
const testOut = execFileSync("python3", ["-c", r.testScript], { timeout: 30000 }).toString();
check("french: example passes", /EI-TEST \d+ PASS/.test(testOut), testOut.trim().split("\n").pop());
check("french: sidecar name", fs.existsSync(path.join(dir, "salutations.eic.json")));

console.log(failures ? `\n${failures} FAILURES` : "\nALL LANGUAGE TESTS PASS");
process.exit(failures ? 1 : 0);
