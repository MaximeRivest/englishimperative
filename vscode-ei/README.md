# English Imperative for VS Code

Write programs in natural language. `.ei` files compile to Bash or Python
through a model engine. The generated code stays visible, inspectable, and
runnable. The model only translates; execution produces all results.

## What you get

- **Compiled view**: `EI: Compile` opens the generated script beside your
  prose. Move the cursor in the `.ei` file; the matching code block
  highlights and scrolls into view.
- **Incremental translation**: each statement's translation is cached in a
  `<name>.eic.json` sidecar. Only changed statements (and their dependents)
  retranslate. Commit the sidecar to pin the whole program for a repo.
- **Pins by default**: the first successful translation freezes automatically.
  Recompiles never alter it. `retranslate` replaces it deliberately. Disable
  `ei.pinByDefault` if you want translations to remain unpinned.
- **AST dependency graph**: Python's AST and scope table extract definitions,
  reads, calls, imports, signatures, and effects. Bash uses a conservative
  analyzer. The graph replaces the old "everything below changed" rule.
- **Precise stale marks**: `✎ stale` marks a changed statement. `↳ dependency
  changed` marks only its real transitive dependents. A pinned dependent shows
  `📌 dependency review`; accept its current dependency interfaces or
  retranslate it.
- **Three hashes per statement**: source, public interface, and implementation.
  An implementation-only change reruns checks without invalidating callers. A
  changed function signature invalidates its callers.
- **Locked builds**: `EI: Locked Build` uses only pins and cached briefs. It
  never calls a model. It fails on missing pins, stale briefs, syntax errors,
  or unresolved pinned dependency changes.
- **Effects**: facts record file reads/writes, deletion, network, processes,
  database access, time, randomness, and unknown dynamic behavior.
- Ghost text (`⟶ code…`) previews the pinned translation.
- **Examples as tests**: a statement that states an expected result (any
  wording) becomes a checked assertion. `EI: Run Example Tests` runs them and
  marks each example line as passed or failed. `ei test` does the same in CI.
- **Ambiguity linter**: one cached model pass warns about pronouns without an
  antecedent, missing units, unclear scope, and vague quantities — before
  translation, as warnings on the exact line.
- **English modules**: "It uses the helpers in ./text-utils.ei" compiles that
  file first (with its own pins), writes its artifact, imports it, and
  describes its API to the model in English. Cycles are compile errors.
- **Warm pi engine**: one persistent `pi --mode rpc` process serves all
  translations (≈15× faster than per-call spawns). It recycles itself and
  falls back to one-shot calls on any failure.
- **English debugger**: `EI: Debug` steps through the program one English
  statement at a time in the terminal: Enter steps, `c` continues, `v` shows
  variables, `p NAME` prints one, `q` quits.
- **REPL (Shift+Enter)**: like RStudio, for Python, R, and bash alike.
  The pane below is the REAL native console — IPython, the R console, or
  plain bash — untouched. Shift+Enter translates the English statement
  (pins and cache answer instantly, only new sentences reach the model)
  and types the generated code into that console, so what you see typed
  is exactly what the runtime receives. State persists in the native
  process; native code you type yourself works as always. The cursor
  advances to the next statement. `EI: Restart REPL Session` starts fresh.
- **Any human language**: the file extension may name the source language —
  full names (`rapport.francais`, `bericht.deutsch`), ISO 639 codes
  (`rapport.fr`, `informe.spa`), combined (`rapport.fr.ei`), or plain `.ei`
  with auto-detection. Identifiers come out in English; strings and printed
  text keep the source language.
- **Diagnostics**: translation failures (including provider refusals with
  their reason) and syntax errors of the generated code map back to the
  English line that caused them.
- **Hover**: hover a statement to see its full generated code.
- **Libraries**: a preamble sentence like "It uses my helper library at
  ~/lib/tools.py" makes the compiler load the library deterministically and
  give the model a cached API brief (`~/.ei/libs`, shared with the ei CLI).
- **Engines**: the status bar item switches between an OpenAI-compatible
  endpoint (`http`) and the pi CLI (`pi`), with pi model picking from
  `pi --list-models`.

## Program format

Free prose. Structural conventions only:

```
This little program is written in Python.
It uses my helper library at ~/lib/mytools.py.

Welcome the user called "Maxime" and print the result.
Then print that same greeting, but shouted.

To welcome someone:
    make the greeting for that person with the library
    give back the greeting
```

- The opening paragraph (optional) says what the program is, its language,
  and its libraries — in any words.
- One statement per line; indent a block body under a line ending in `:`.
- `#` starts a comment; a trailing `\` continues a line.
- Definitions may sit below their first use (they hoist, like JS functions).

## Commands

| Command | Effect |
| --- | --- |
| `EI: Compile` | translate changed statements, open the compiled view |
| `EI: Run` | compile, then run the script in the `ei` terminal |
| `EI: Compile To File` | write `name.py` / `name.sh` next to the source |
| `EI: Retranslate Statement` | force a fresh translation of one statement |
| `EI: Pin / Unpin Statement` | freeze / release one translation |
| `EI: Select Engine And Model` | switch engine, pick a pi model |
| `EI: Rebuild Library Briefs` | refresh the cached library documentation |
| `EI: Clear Translation Cache` | drop all cached translations and pins |
| `EI: Locked Build` | verify and build from pins only; never call a model |
| `EI: Show Dependency Graph` | open a Mermaid graph and semantic-facts table |
| `EI: Accept Pinned Dependency Changes` | keep pinned code and accept current dependency interfaces |
| `EI: Run Example Tests` | compile and run the program's stated examples |
| `EI: Debug (Step Through English)` | instrumented run, one pause per English statement |

## Settings

- `ei.engine`: `http` (default) or `pi`
- `ei.http.url`, `ei.http.apiKey`, `ei.http.model`
- `ei.pi.model` (`provider/id`), `ei.pi.modeFile` (pi prompt-mode JSON)
- `ei.pinByDefault` (default true), `ei.lint` (default true)
- `ei.compileOnSave` (default true), `ei.ghostCode` (default true)
