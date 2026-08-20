"""ei_ipython — natural language in your normal IPython session.

Load:  %load_ext ei_ipython   (or via a startup file)

Valid Python runs as always. A cell that does not parse as Python, or a
line that starts with a comma, goes to the model and comes back as Python
code. The code runs in THIS session: variables and imports persist.

The model sees: the variables in the namespace, recent history with
outputs, and your statement. Static instructions come first so vLLM
prefix caching works.
"""

import ast
import json
import os
import re
import urllib.request

EI_URL = os.environ.get("EI_URL", "http://192.168.2.24:8000/v1/chat/completions")
EI_KEY = os.environ.get("EI_KEY", "inktype-local")
EI_MODEL = os.environ.get("EI_MODEL", "qwen/qwen3.8-27b")
EI_HIST = int(os.environ.get("EI_HIST_LINES", "25"))
EI_GUARD = os.environ.get("EI_GUARD", "1") == "1"

_SYS = (
    "You are a strict English-to-Python interpreter inside a live IPython "
    "session. Translate the user's statement into Python code. Output ONLY "
    "the code: no markdown fences, no comments, no explanation. The code "
    "runs directly in the user's session. The user may refer to variables, "
    "recent history, or recent outputs in the context. When the user asks a "
    "question, prefer code that computes and prints the answer. Only when "
    "the user clearly asks about something already visible in the context, "
    "reply with a single print of the answer, like: print('the answer.')"
)

_DANGEROUS = re.compile(
    r"(shutil\.rmtree|os\.remove|os\.unlink|os\.rmdir|\.unlink\(|rmdir\("
    r"|subprocess.*(rm -|mkfs|dd )|os\.system|DROP\s+(TABLE|DATABASE)"
    r"|\.drop\(.*inplace|open\([^)]*['\"]w)",
    re.IGNORECASE,
)


def _context(ip):
    parts = []
    hist = list(ip.history_manager.get_range(output=True))[-EI_HIST:]
    if hist:
        parts.append("Recent session history, oldest first:")
        for _, n, (inp, out) in hist:
            parts.append(f"In [{n}]: {inp}")
            if out:
                parts.append(f"Out[{n}]: {str(out)[:500]}")
    names = [
        f"{k} = {type(v).__name__}"
        for k, v in ip.user_ns.items()
        if not k.startswith("_") and k not in ("In", "Out", "exit", "quit", "get_ipython", "open")
    ]
    if names:
        parts.append("")
        parts.append("Variables in the namespace:")
        parts.append(", ".join(names[:60]))
    parts.append("")
    parts.append(f"Current directory: {os.getcwd()}")
    return "\n".join(parts)


def _translate(ip, intent):
    user = f"{_context(ip)}\n\nStatement to translate: {intent}"
    body = json.dumps(
        {
            "model": EI_MODEL,
            "temperature": 0,
            "max_tokens": 500,
            "messages": [
                {"role": "system", "content": _SYS},
                {"role": "user", "content": user},
            ],
        }
    ).encode()
    req = urllib.request.Request(
        EI_URL,
        data=body,
        headers={
            "Authorization": f"Bearer {EI_KEY}",
            "Content-Type": "application/json",
        },
    )
    with urllib.request.urlopen(req, timeout=60) as r:
        content = json.load(r)["choices"][0]["message"]["content"]
    return re.sub(r"^```[a-z]*\n?|```$", "", content.strip(), flags=re.M).strip()


def _is_python(cell):
    try:
        ast.parse(cell)
        return True
    except SyntaxError:
        return False


def _make_transformer(ip):
    def ei_transform(lines):
        cell = "".join(lines)
        stripped = cell.strip()
        if not stripped:
            return lines
        if stripped.startswith(","):
            intent = stripped.lstrip(", ").strip().strip('"')
        elif not _is_python(cell):
            intent = stripped
        else:
            return lines
        try:
            code = _translate(ip, intent)
        except Exception as e:
            return [f"print('ei: translation failed: {e}')\n"]
        if not code:
            return ["print('ei: empty translation')\n"]
        trace = "\n= ".join(code.splitlines())
        print(f"\033[2m= {trace}\033[0m")
        if EI_GUARD and _DANGEROUS.search(code):
            reply = input("ei: this looks destructive. run it? [y/N] ")
            if reply.lower() != "y":
                return ["print('ei: skipped')\n"]
        return [line + "\n" for line in code.splitlines()]

    ei_transform.has_side_effects = True  # do not run during check_complete
    return ei_transform


def load_ipython_extension(ip):
    ip.input_transformers_cleanup.append(_make_transformer(ip))


def unload_ipython_extension(ip):
    ip.input_transformers_cleanup[:] = [
        t for t in ip.input_transformers_cleanup if t.__name__ != "ei_transform"
    ]
