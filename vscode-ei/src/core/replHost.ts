// The ei REPL host: a real interactive prompt that accepts BOTH Python and
// natural language. English lines go to the extension's local translation
// server (pins, cache, warm engine), the generated code echoes visibly
// (⟶ lines), and everything executes in one persistent namespace.
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
