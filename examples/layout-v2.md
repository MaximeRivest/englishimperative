# ei layout v2 — full programs in English

Design principle: English gives intent. We borrow only three things from
programming, because English does them badly:

1. **Names** — `=` binds a name. Pronouns ("it", "them") reach only one line back.
2. **Blocks** — indentation, like Python. A line that ends with `:` opens a block.
3. **Tables** — aligned `|` rows for data and for case-by-case rules.

Everything else stays prose. No abbreviations: the whole point is readability.

---

## A full example program

```
@target python

# invoice-report.ei — summarize a folder of invoice csv files

rate = 0.15                          # plain assignment, comments as usual
folder = the path given as the first command line argument

to load one invoice from a path:
    read it as a csv with columns date, client, amount
    drop the rows where the amount is empty
    give back the rows                        # "give back" = return

to classify an amount:
    | when it is        | give back |
    | over 10000        | "large"   |
    | between 1000 and  |           |
    |   10000           | "medium"  |
    | anything else     | "small"   |

invoices = an empty list
for each csv file in the folder, oldest first:
    rows = load one invoice from that file
    if the file has no rows:
        warn about it and skip it
    add the rows to invoices

for each client, using all invoices together:
    total    = the sum of their amounts
    tax      = total times rate
    category = classify the total
    remember these four things per client

print the per-client results as an aligned table, largest total first
save the same table as report.csv
```

---

## The pieces

### Assignment: `=`
English has no good assignment. "let the rate be 0.15" is longer and vaguer
than `rate = 0.15`. The right side stays English:

```
deadline = the last friday of this month
```

### Functions: `to <phrase> with <things>:`
A function is a taught skill. You teach it with "to", you use it by saying it:

```
to greet a person by name:
    print hello followed by the name

greet each name in guests
```

### Blocks: indentation and `:`
Proven by Python. Nesting stays readable in English:

```
for each server in servers.txt:
    if it does not answer a ping:
        append it to down.txt
```

### Case tables instead of if-chains
An if/elif chain in English is noise. A decision table is instantly scannable:

```
to price a ticket:
    | when the age is | the price is |
    | under 5         | 0            |
    | 5 to 17         | 8            |
    | 65 and up       | 6            |
    | anything else   | 12           |
```

### Data tables as literals
```
servers =
    | name  | host          | critical |
    | web   | 192.168.2.10  | yes      |
    | db    | 192.168.2.11  | yes      |
    | test  | 192.168.2.30  | no       |
```

### What we deliberately do NOT add
- Abbreviations ("fn", "ret") — they recreate the syntax we escaped.
- Types — the interpreter infers them; say "as a number" when it matters.
- Braces, semicolons, parentheses for calls — indentation and prose suffice.
```
