// The ei REPL hosts: real interactive prompts that accept BOTH the target
// language and natural language. English lines go to the extension's local
// translation server (pins, cache, warm engine), the generated code echoes
// visibly (⟶ lines), and everything executes in one persistent process.
// Three hosts, one behavior: Python, R, and bash.
export const PY_REPL_HOST = `
import codeop, json, os, sys, traceback, urllib.request
try:
    import readline  # line editing + history
except Exception:
    pass

PORT = int(os.environ["EI_REPL_PORT"])
TOKEN = os.environ.get("EI_REPL_TOKEN", "")
G = {"__name__": "__main__"}

def translate(text):
    body = json.dumps({"token": TOKEN, "text": text}).encode()
    req = urllib.request.Request(
        "http://127.0.0.1:%d/translate" % PORT, data=body,
        headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=600) as r:
        return json.loads(r.read())

def is_python(src):
    try:
        compile(src, "<ei>", "exec")
        return True
    except SyntaxError:
        return False

def run(code):
    try:
        try:
            c = compile(code, "<ei>", "single")  # expressions echo like a REPL
        except SyntaxError:
            c = compile(code, "<ei>", "exec")
        exec(c, G)
        return True
    except SystemExit:
        raise
    except BaseException:
        traceback.print_exc()
        return False

prelude = os.environ.get("EI_REPL_PRELUDE", "")
if prelude and os.path.exists(prelude):
    with open(prelude) as f:
        run(f.read())
    print("[ei] libraries loaded")
print("[ei] English or Python. A ',' prefix forces translation. Ctrl+D exits.")

while True:
    try:
        line = input("ei> ")
    except EOFError:
        print()
        break
    except KeyboardInterrupt:
        print()
        continue
    if not line.strip():
        continue
    # a block: a line ending in ':' collects its indented body
    if line.rstrip().endswith(":"):
        body = []
        while True:
            try:
                more = input("... ")
            except EOFError:
                more = ""
            if not more.strip():
                break
            body.append(more)
        line = "\\n".join([line] + body)
    forced = line.lstrip().startswith(",")
    text = line.lstrip()[1:].strip() if forced else line
    if not forced and is_python(text):
        run(text)
        continue
    try:
        resp = translate(text)
    except Exception as e:
        print("[ei] translation server unreachable: %s" % e)
        continue
    if resp.get("skip"):
        print("[ei] " + resp.get("note", "skipped"))
        continue
    if resp.get("error"):
        print("[ei] " + resp["error"])
        continue
    code = resp.get("code", "").rstrip()
    for l in code.split("\\n"):
        print("\\u27f6 " + l)
    ok = run(code)
    if ok and resp.get("kind") == "example":
        print("[ei] \\u2713 example holds")
`;

// The R host runs under Rscript. It uses the plain-text /translate-raw
// endpoint through curl, so it needs no JSON package. Incomplete R input
// continues on a "... " prompt, exactly like R's own "+".
export const R_REPL_HOST = `
port <- Sys.getenv("EI_REPL_PORT")
token <- Sys.getenv("EI_REPL_TOKEN")
url <- sprintf("http://127.0.0.1:%s/translate-raw", port)
stdin_con <- file("stdin", open = "r")

read_line <- function(prompt) {
  cat(prompt); flush(stdout())
  l <- readLines(stdin_con, n = 1)
  if (length(l) == 0) NULL else l
}

parse_state <- function(txt) {
  tryCatch({ parse(text = txt); "ok" }, error = function(e) {
    if (grepl("unexpected end of input", conditionMessage(e))) "incomplete" else "error"
  })
}

run <- function(code) {
  ok <- TRUE
  tryCatch({
    exprs <- parse(text = code)
    for (e in exprs) {
      res <- withVisible(eval(e, envir = .GlobalEnv))
      if (res$visible) print(res$value)
    }
  }, error = function(e) { ok <<- FALSE; message("Error: ", conditionMessage(e)) })
  ok
}

translate <- function(text) {
  tf <- tempfile(); on.exit(unlink(tf))
  cat(text, file = tf)
  out <- suppressWarnings(tryCatch(system2("curl",
    c("-sS", "-X", "POST", "-H", shQuote(paste0("x-ei-token: ", token)),
      "--data-binary", paste0("@", tf), url),
    stdout = TRUE, stderr = FALSE), error = function(e) character(0)))
  if (length(out) == 0) return(list(status = "error", payload = "translation server unreachable"))
  list(status = out[1], payload = paste(out[-1], collapse = "\\n"))
}

prelude <- Sys.getenv("EI_REPL_PRELUDE")
if (nzchar(prelude) && file.exists(prelude)) {
  sys.source(prelude, envir = .GlobalEnv)
  cat("[ei] libraries loaded\\n")
}
cat("[ei] English or R. A ',' prefix forces translation. Ctrl+D exits.\\n")

repeat {
  line <- read_line("ei> ")
  if (is.null(line)) { cat("\\n"); break }
  if (!nzchar(trimws(line))) next
  # an English block: a line ending in ':' collects its body until a blank line
  if (grepl(":\\\\s*$", line)) {
    repeat {
      more <- read_line("... ")
      if (is.null(more) || !nzchar(trimws(more))) break
      line <- paste(line, more, sep = "\\n")
    }
  }
  forced <- grepl("^\\\\s*,", line)
  text <- if (forced) trimws(sub("^\\\\s*,", "", line)) else line
  state <- if (forced) "force" else parse_state(text)
  # incomplete R continues like R's own "+" prompt
  while (state == "incomplete") {
    more <- read_line("... ")
    if (is.null(more)) { state <- "error"; break }
    text <- paste(text, more, sep = "\\n")
    state <- parse_state(text)
  }
  if (state == "ok") { run(text); next }
  resp <- translate(text)
  if (resp$status == "error") { cat("[ei]", resp$payload, "\\n"); next }
  if (resp$status == "skip") { cat("[ei]", if (nzchar(resp$payload)) resp$payload else "skipped", "\\n"); next }
  for (cl in strsplit(resp$payload, "\\n", fixed = TRUE)[[1]]) cat("\\u27f6", cl, "\\n")
  ok <- run(resp$payload)
  if (ok && resp$status == "ok-example") cat("[ei] \\u2713 example holds\\n")
}
`;

// The bash host: one prompt, English or bash. A line whose first word is a
// real command (or that looks like shell syntax) runs directly; anything
// else translates. State (variables, cwd, functions) lives in this shell.
export const BASH_REPL_HOST = `
ei_url="http://127.0.0.1:\${EI_REPL_PORT}/translate-raw"

ei_read() {  # $1 = prompt; fills REPLY; returns read's status
  if [ -t 0 ]; then
    IFS= read -er -p "$1" REPLY
  else
    printf '%s' "$1"
    IFS= read -r REPLY
  fi
}

ei_translate() {  # $1 = text; sets EI_STATUS and EI_PAYLOAD
  local resp
  if ! resp=$(curl -sS -X POST -H "x-ei-token: \${EI_REPL_TOKEN}" --data-binary @- "$ei_url" <<<"$1" 2>/dev/null); then
    EI_STATUS=error; EI_PAYLOAD="translation server unreachable"; return
  fi
  EI_STATUS=\${resp%%$'\\n'*}
  if [ "$EI_STATUS" = "$resp" ]; then EI_PAYLOAD=""; else EI_PAYLOAD=\${resp#*$'\\n'}; fi
}

looks_like_bash() {  # valid syntax AND a plausible first token
  local t=$1 first
  bash -n <<<"$t" 2>/dev/null || return 1
  case $t in
    [a-zA-Z_]*=*) return 0 ;;                      # assignment
    ./*|/*|\\$*|\\(*|\\{*|~*|\\[*|!*) return 0 ;;  # shell-shaped starts
  esac
  first=\${t%%[[:space:]]*}
  type -t -- "$first" >/dev/null 2>&1
}

if [ -n "$EI_REPL_PRELUDE" ] && [ -f "$EI_REPL_PRELUDE" ]; then
  source "$EI_REPL_PRELUDE"
  echo "[ei] libraries loaded"
fi
echo "[ei] English or bash. A ',' prefix forces translation. Ctrl+D exits."

while ei_read "ei> "; do
  line=$REPLY
  [ -z "\${line//[[:space:]]/}" ] && continue
  # an English block: a line ending in ':' collects its body until a blank line
  trimmed_end=\${line%"\${line##*[![:space:]]}"}
  if [ "\${trimmed_end: -1}" = ":" ]; then
    while ei_read "... "; do
      [ -z "\${REPLY//[[:space:]]/}" ] && break
      line+=$'\\n'"$REPLY"
    done
  fi
  forced=0
  text=\${line#"\${line%%[![:space:]]*}"}
  if [ "\${text:0:1}" = "," ]; then
    forced=1
    text=\${text:1}
    text=\${text#"\${text%%[![:space:]]*}"}
  fi
  if [ "$forced" = 0 ] && looks_like_bash "$text"; then
    eval -- "$text"
    continue
  fi
  ei_translate "$text"
  case $EI_STATUS in
    error) echo "[ei] $EI_PAYLOAD" ;;
    skip)  echo "[ei] \${EI_PAYLOAD:-skipped}" ;;
    ok|ok-example)
      while IFS= read -r cl; do printf '\\u27f6 %s\\n' "$cl"; done <<<"$EI_PAYLOAD"
      if eval -- "$EI_PAYLOAD"; then
        [ "$EI_STATUS" = "ok-example" ] && printf '[ei] \\u2713 example holds\\n'
      fi
      ;;
  esac
done
echo
`;
