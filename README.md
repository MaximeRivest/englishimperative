# English Imperative

Write commands in plain English. An AI interprets each line into code.
The code runs in a live REPL session, or you save it as a script.

## Idea

You do not write code. You write intent, one line at a time:

```
> load the csv file sales.csv
> keep only the rows from 2024
> group by region and sum the revenue
> plot the result as a bar chart
> save the chart as sales_2024.png
```

The interpreter converts each line into code (Python by default),
runs it immediately, and shows the code with the output.
The session keeps all state between lines.

## Core rule: the AI is only an interpreter

The AI never answers you. The AI only translates English into code.
All output comes from the execution of the code, not from the AI.

- If you ask a question, the AI generates code that computes the answer.
- If the code fails, you see the real error from the runtime.
- The AI adds no explanations, no summaries, and no opinions.

This rule keeps the tool honest: what you see is what your machine did.

There are no confirmations. A human interpreter between two speakers does
not stop to confirm each sentence. The interpreter just interprets.
Your English line is the command. The execution is immediate.
If you want a safeguard, say it in English ("ask me before you delete"),
and the generated code contains the prompt.

## Core rule: no reserved words, ever

The user never has to learn specific vocabulary. Wording is never
load-bearing. Only two things carry meaning:

- **Structure**: position and format, like a paper or a resume. The
  opening paragraph introduces the program. A line ending in ':' opens an
  indented block. '#' comments, '\' continues a line. That is all.
- **Interpretation**: model passes read intent from meaning, in any
  phrasing. The survey pass, the statement translator, and the repair
  pass are independent interpreters, so one misreading does not break
  the program.

Implementation consequences:

- No keyword may ever be required. Directives like '@target' stay legal
  as optional overrides only.
- Prompts must not teach "magic phrases" as the way to express something;
  they instruct the model to accept any wording with that meaning.
- Detection logic in code (not in the model) may use structure (file
  extensions, indentation, punctuation, paths) but never English words.
- Every layer fails soft: a missed extraction falls through to the next
  interpreter, and runtime errors stay visible.

## Modes

### REPL mode

```
$ ei
ei> load the csv file sales.csv
  = df = pd.read_csv("sales.csv")
  ok: dataframe with 5,214 rows, 8 columns

ei> keep only the rows from 2024
  = df = df[df["date"].str.startswith("2024")]
  ok: 1,102 rows remain
```

### Script mode

Write your intent in a `.ei` file. Compile it into a real script:

```
$ ei compile examples/report.ei -o report.py
$ python report.py
```

### Editor mode

The installed VS Code extension provides compiled-code views, statement
pins, precise dependency staleness, diagnostics, locked builds, and a
semantic dependency graph.

## Transparency, not confirmation

- The tool runs the code immediately, then shows the code next to the output.
- There is no undo. A real interpreter cannot take words back, and a
  shell or Python session cannot reverse a statement.
- Use `--dry-run` to translate only: see the code, do not run it.
- If you want a check before a dangerous step, write it in your statement.

## The .ei file format

- An optional opening paragraph describes the program, target, and libraries
  in any words.
- One statement goes on each top-level line.
- Indent a block body under a line that ends in `:`.
- Lines that start with `#` are comments.
- A line that ends with `\` continues on the next line.
- Optional directives such as `@target python` remain compatible, but users
  never need them.

See the `examples/` folder for complete examples.

## Reproducible programs

The first successful translation pins by default in a `.eic.json` sidecar.
Each statement records source, interface, and implementation hashes. Python
AST and scope analysis build a dependency graph, so only real dependents
become stale. A locked build uses pins only and never calls a model.

## Status

Working implementation: Bash/Python CLI, Bash/IPython/R interactive modes,
and an installed VS Code extension. The extension includes incremental
compilation, pins, dependency analysis, source maps, diagnostics, locked
builds, and an inspectable graph.
