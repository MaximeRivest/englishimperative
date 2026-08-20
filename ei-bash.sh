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
# Note: bash runs command_not_found_handle in a subshell. The handler
# therefore writes the generated code to a pending file, and
# PROMPT_COMMAND evaluates it in the parent shell.

EI_URL="${EI_URL:-http://192.168.2.24:8000/v1/chat/completions}"
EI_KEY="${EI_KEY:-inktype-local}"
EI_MODEL="${EI_MODEL:-qwen/qwen3.8-27b}"
EI_PENDING="${EI_PENDING:-/tmp/ei-pending.$$}"

_ei_translate() {
    local intent="$1"
    local sys="You are a strict English-to-bash interpreter inside a live interactive bash session on Linux. Translate the user's statement into bash code. Output ONLY the code: no markdown fences, no comments, no explanation. The code runs directly with eval in the user's shell. Current directory: $PWD"
    jq -n --arg model "$EI_MODEL" --arg sys "$sys" --arg user "$intent" \
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

_ei_run_pending() {
    if [[ -s "$EI_PENDING" ]]; then
        local code
        code=$(<"$EI_PENDING")
        : > "$EI_PENDING"
        printf '\033[2m= %s\033[0m\n' "${code//$'\n'/$'\n'= }" >&2
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

trap '[[ -f "$EI_PENDING" ]] && rm -f "$EI_PENDING"' EXIT
