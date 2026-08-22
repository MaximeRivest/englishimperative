import { CompileResult, Target } from "./types";

// English-statement debugger: instrument the generated script so execution
// pauses before each statement, shows the English line plus the code, and
// accepts simple commands. No DAP needed; it runs in any terminal.
//
//   Enter        step to the next English statement
//   c            continue to the end
//   v            show top-level variables
//   p NAME       print one variable
//   q            quit

const PY_HELPER = `
def __ei_pause(line, stmt):
    import sys
    print(f"\\n[ei] line {line}: {stmt}", flush=True)
    while True:
        try:
            __c = input("[ei] Enter=step c=continue v=vars p NAME=print q=quit> ").strip()
        except EOFError:
            return False
        if __c == "":
            return True
        if __c == "c":
            return False
        if __c == "q":
            sys.exit(0)
        if __c == "v":
            for __k, __v in sorted(globals().items()):
                if not __k.startswith("__") and not callable(__v) and not isinstance(__v, type(sys)):
                    print(f"[ei]   {__k} = {repr(__v)[:120]}")
            continue
        if __c.startswith("p "):
            __n = __c[2:].strip()
            print("[ei]  ", repr(globals().get(__n, f"<{__n} is not defined>"))[:500])
            continue
        print("[ei] commands: Enter step, c continue, v vars, p NAME, q quit")
__ei_step = True
`;

const SH_HELPER = `
__ei_step=1
__ei_pause() {
  printf '\\n[ei] line %s: %s\\n' "$1" "$2"
  while true; do
    printf '[ei] Enter=step c=continue v=vars q=quit> '
    IFS= read -r __c < /dev/tty || { __ei_step=0; return; }
    case "$__c" in
      "") return ;;
      c) __ei_step=0; return ;;
      q) exit 0 ;;
      v) declare -p 2>/dev/null | grep -v '^declare -[a-z-]* __ei\\|^declare -[a-z-]* BASH' | head -30 ;;
      *) echo '[ei] commands: Enter step, c continue, v vars, q quit' ;;
    esac
  done
}
`;

function quote(target: Target, s: string): string {
  const first = s.split("\n")[0].slice(0, 120);
  return target === "python"
    ? JSON.stringify(first)
    : `'${first.replace(/'/g, "'\\''")}'`;
}

export function instrument(result: CompileResult): string {
  const lines = result.script.split("\n");
  const blocks = [...result.blocks].filter(b => b.code).sort((a, b) => b.genStart - a.genStart);
  for (const b of blocks) {
    const call = result.target === "python"
      ? `if __ei_step: __ei_step = __ei_pause(${b.unit.startLine + 1}, ${quote(result.target, b.unit.text)})`
      : `[ "$__ei_step" = 1 ] && __ei_pause ${b.unit.startLine + 1} ${quote(result.target, b.unit.text)}`;
    lines.splice(b.genStart, 0, call);
  }
  const helper = result.target === "python" ? PY_HELPER : SH_HELPER;
  // insert the helper after the shebang line
  lines.splice(1, 0, helper);
  return lines.join("\n");
}
