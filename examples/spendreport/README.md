# spendreport — a complete English Imperative project

A real little tool, written entirely in natural language: it reads
`expenses.csv` and prints a monthly spending report by category.

## Files

| File | Role |
| --- | --- |
| `report.ei` | the program: reads the CSV, totals by category, prints the report |
| `money.ei` | English module: parse and format money amounts |
| `categorize.ei` | English module: a decision table from merchant name to category |
| `expenses.csv` | the data |
| `*.eic.json` | sidecars: pinned translations, survey, dependency graph |
| `money.py`, `categorize.py`, `spendreport.py` | generated artifacts |

## What it demonstrates

- Free-prose preamble: language and dependencies stated in plain sentences.
- English modules: `report.ei` uses `./money.ei` and `./categorize.ei`;
  each compiles with its own pins, and its API is described to the model
  in English.
- A decision table (`categorize.ei`) that compiles to conditional logic.
- Examples as tests in every file (`ei test money.ei` → 4 checks).
- The ambiguity linter: it flagged "next to this program" before that
  wording caused a real path bug; the fix was clearer prose.
- Pin-by-default and automatic dependency-driven retranslation: editing the
  read statement retranslated only its dependents.
- Locked build: `ei locked report.ei -o spendreport.py` rebuilds from pins
  with zero model calls.
- The dependency graph: `ei graph report.ei` shows defines/reads/calls,
  effects (`reads_files`), and the three hashes per statement.

## Commands

```bash
ei test money.ei          # 4 example checks
ei test categorize.ei     # 4 example checks
ei test report.ei         # runs the program, then 3 checks
ei run report.ei          # the actual report
ei locked report.ei -o spendreport.py   # reproducible, no model
ei graph report.ei        # the semantic graph
ei debug report.ei        # step through it in English
```

Expected report:

```
Spending report
  groceries: $236.80
  transport: $121.05
  eating out: $81.85
  other: $39.99
  health: $28.48
  TOTAL: $508.17
```
