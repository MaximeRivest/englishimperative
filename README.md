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

### Inline mode

One command, run and exit:

```
$ ei run "rename all .jpeg files in this folder to .jpg"
```

## Transparency, not confirmation

- The tool runs the code immediately, then shows the code next to the output.
- There is no undo. A real interpreter cannot take words back, and a
  shell or Python session cannot reverse a statement.
- Use `--dry-run` to translate only: see the code, do not run it.
- If you want a check before a dangerous step, write it in your statement.

## The .ei file format

- One statement per line.
- Lines that start with `#` are comments.
- A line that ends with `\` continues on the next line.
- `@target python` or `@target bash` sets the output language (first line).

See the `examples/` folder for full examples.

## Status

Design phase. This README and the examples define the intended behavior.
No implementation exists yet.
