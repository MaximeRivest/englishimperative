# ei-bash.sh — natural language in your normal bash session.
# Source this file:  source ei-bash.sh
#
# Real commands run as always. When the first word is not a command,
# the line goes to the model, comes back as bash code, and runs in
# THIS shell (cd, variables, pipes all persist).
#
# Escape hatch: when the first word IS a real command (make, show, cut...),
# start the line with a comma to force translation:
#   , make a folder called backup and go into it
#
# Bash parses (, ), |, ; and > before any hook can run. For a line with
# such characters, quote it:  , "list the files (only the logs)"
# or type the plain line and press Alt-Enter: readline wraps it for you.
#
# Note: bash runs command_not_found_handle in a subshell. The handler
# therefore writes the generated code to a pending file, and
# PROMPT_COMMAND evaluates it in the parent shell.

EI_URL="${EI_URL:-http://192.168.2.24:8000/v1/chat/completions}"
EI_KEY="${EI_KEY:-inktype-local}"
EI_MODEL="${EI_MODEL:-qwen/qwen3.8-27b}"
EI_PENDING="${EI_PENDING:-/tmp/ei-pending.$$}"
EI_LOG="${EI_LOG:-/tmp/ei-session.$$.log}"
EI_LOG_BYTES="${EI_LOG_BYTES:-3000}"   # how much recent output the model sees
EI_HIST_LINES="${EI_HIST_LINES:-200}"  # how many history lines the model sees
EI_GUARD="${EI_GUARD:-1}"              # 1 = confirm irreversible commands, 0 = off

# Capture all session output into EI_LOG so the model can see what you saw.
if [[ $- == *i* && -z "$EI_CAPTURE_ON" ]]; then
    EI_CAPTURE_ON=1
    : > "$EI_LOG"
    exec > >(tee -a "$EI_LOG") 2> >(tee -a "$EI_LOG" >&2)
fi

# Context ordering matters for vLLM prefix caching: the KV cache is reused
# for the identical prompt prefix. So: static instructions first, then
# append-only history (old lines never change), then the volatile block
# (pwd, ls, output tail) and the statement at the very end.
_ei_context() {
    echo "Session history, oldest first:"
    history "$EI_HIST_LINES" 2>/dev/null | sed 's/^ *[0-9]* *//'
    echo
    echo "Current directory: $PWD"
    echo
    echo "Files here (truncated):"
    ls -1 2>/dev/null | head -40
    if [[ -s "$EI_LOG" ]]; then
        echo
        echo "Recent terminal output (may be what the user refers to):"
        tail -c "$EI_LOG_BYTES" "$EI_LOG"
    fi
}

_ei_translate() {
    local intent="$1"
    local sys="You are a strict English-to-bash interpreter inside a live interactive bash session on Linux. Translate the user's statement into bash code. Output ONLY the code: no markdown fences, no comments, no explanation. The code runs directly with eval in the user's shell. The user may refer to the recent history or terminal output in the context. When the user asks a question, prefer code that computes the answer. Only when the user clearly asks for an answer that is already visible in the context (for example: what did that error mean? which file was it?), reply with a single echo of the answer, like: echo 'the answer.'"
    local ctx
    ctx="$(_ei_context)

Statement to translate: $intent"
    jq -n --arg model "$EI_MODEL" --arg sys "$sys" --arg user "$ctx" \
        '{model:$model, temperature:0, max_tokens:500,
          messages:[{role:"system",content:$sys},{role:"user",content:$user}]}' \
    | curl -s --max-time 60 "$EI_URL" \
        -H "Authorization: Bearer $EI_KEY" \
        -H "Content-Type: application/json" \
        -d @- \
    | jq -r '.choices[0].message.content // empty' \
    | sed -e 's/^```[a-z]*$//' -e 's/^```$//'
}

command_not_found_handle() {
    local intent="$*"
    local code
    code=$(_ei_translate "$intent")
    if [[ -z "$code" ]]; then
        printf 'ei: translation failed (no answer from %s)\n' "$EI_URL" >&2
        return 127
    fi
    printf '%s\n' "$code" > "$EI_PENDING"
    return 0
}

# Patterns that can destroy data or the system. Extend as needed.
_ei_dangerous() {
    grep -qE '(rm .*(-[a-zA-Z]*r[a-zA-Z]*f|-[a-zA-Z]*f[a-zA-Z]*r)|rm -(r|f)?\s|mkfs|dd .*of=/dev|> */dev/sd|chmod +-R|chown +-R|shred|truncate|git +(reset +--hard|clean +-|push +--force)|drop +(table|database)|:\(\)\{|sudo )' <<<"$1"
}

_ei_run_pending() {
    if [[ -s "$EI_PENDING" ]]; then
        local code reply
        code=$(<"$EI_PENDING")
        : > "$EI_PENDING"
        printf '\033[2m= %s\033[0m\n' "${code//$'\n'/$'\n'= }" >&2
        if [[ "$EI_GUARD" == 1 ]] && _ei_dangerous "$code"; then
            read -r -p 'ei: this looks irreversible. run it? [y/N] ' reply
            [[ "$reply" == y || "$reply" == Y ]] || { echo 'ei: skipped' >&2; return; }
        fi
        history -s "$code"
        eval "$code"
    fi
}

, () {
    command_not_found_handle "$@"
}

if [[ ":$PROMPT_COMMAND:" != *":_ei_run_pending:"* ]]; then
    PROMPT_COMMAND="_ei_run_pending${PROMPT_COMMAND:+;$PROMPT_COMMAND}"
fi

# Alt-Enter: wrap the current line as , "..." and submit it.
if [[ $- == *i* ]]; then
    bind '"\e\C-m": "\C-a, \"\C-e\"\C-m"'
fi

trap '[[ -f "$EI_PENDING" ]] && rm -f "$EI_PENDING"' EXIT
