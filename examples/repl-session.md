# Example REPL session

This transcript shows the intended REPL behavior.

```
$ ei
english imperative v0.1 — type your intent, or :help

ei> load the csv file sales.csv
  = import pandas as pd
  = df = pd.read_csv("sales.csv")
  ok: dataframe "df", 5214 rows, 8 columns

ei> what columns does it have?
  = print(list(df.columns))
  ['date', 'region', 'product', 'units', 'price', 'revenue', 'rep', 'channel']

ei> keep only the rows from 2024
  = df = df[pd.to_datetime(df["date"]).dt.year == 2024]
  ok: 1102 rows remain

ei> :show
  # code generated so far in this session
  import pandas as pd
  df = pd.read_csv("sales.csv")
  df = df[pd.to_datetime(df["date"]).dt.year == 2024]

ei> :save session.py
  ok: wrote session.py

ei> :quit
```

## REPL commands

| Command        | Effect                                     |
|----------------|--------------------------------------------|
| `:show`        | Show all code kept in this session         |
| `:save FILE`   | Write the session code to a file           |
| `:quit`        | Exit                                       |

The AI is only an interpreter. It never answers by itself, and it never
asks for confirmation. It translates and the code runs, immediately.
A question also becomes code. The code computes and prints the answer.
Questions do not change state and do not go into the saved script.

The `=` lines show the code that ran. They are a trace, not a prompt.
There is no undo. If a translation was wrong, say a new statement that
corrects the state, the same way you would in a normal REPL.
