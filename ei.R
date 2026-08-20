# ei.R — natural language in your normal R session.
# Source this file, then call ei_repl(). Or load it from ~/.Rprofile.
#
# Valid R runs as always. A line that does not parse as R, or a line that
# starts with a comma, goes to the model and comes back as R code. The code
# runs in the global environment: variables and libraries persist.

.ei <- new.env()
.ei$url   <- Sys.getenv("EI_URL",  "http://192.168.2.24:8000/v1/chat/completions")
.ei$key   <- Sys.getenv("EI_KEY",  "inktype-local")
.ei$model <- Sys.getenv("EI_MODEL", "qwen/qwen3.8-27b")
.ei$hist  <- as.integer(Sys.getenv("EI_HIST_LINES", "25"))
.ei$guard <- Sys.getenv("EI_GUARD", "1") == "1"
.ei$log   <- character()   # rolling history of inputs and outputs

.ei$sys <- paste(
  "You are a strict English-to-R interpreter inside a live interactive R",
  "session. Translate the user's statement into R code. Output ONLY the",
  "code: no markdown fences, no comments, no explanation. The code runs",
  "directly in the user's global environment. The user may refer to",
  "variables, recent history, or recent outputs in the context. When the",
  "user asks a question, prefer code that computes and prints the answer.",
  "Only when the user clearly asks about something already visible in the",
  "context, reply with a single cat() of the answer.")

.ei$danger <- "unlink|file\\.remove|system\\(|system2\\(|rm -|shell\\(|DROP TABLE|drop_table"

.ei$esc <- function(s) {
  s <- gsub("\\\\", "\\\\\\\\", s)
  s <- gsub("\"", "\\\\\"", s)
  s <- gsub("\n", "\\\\n", s)
  s <- gsub("\t", "\\\\t", s)
  s
}

.ei$context <- function() {
  parts <- character()
  n <- length(.ei$log)
  if (n > 0) {
    keep <- .ei$log[max(1, n - .ei$hist * 2):n]
    parts <- c(parts, "Recent session history and output, oldest first:", keep, "")
  }
  vars <- setdiff(ls(globalenv()), c("ei_repl"))
  if (length(vars) > 0) {
    info <- vapply(vars, function(v)
      paste0(v, " = ", class(get(v, envir = globalenv()))[1]), "")
    parts <- c(parts, "Variables in the environment:",
               paste(head(info, 60), collapse = ", "), "")
  }
  parts <- c(parts, paste("Current directory:", getwd()))
  paste(parts, collapse = "\n")
}

.ei$translate <- function(intent) {
  user <- paste0(.ei$context(), "\n\nStatement to translate: ", intent)
  body <- paste0(
    '{"model":"', .ei$model, '","temperature":0,"max_tokens":500,',
    '"messages":[{"role":"system","content":"', .ei$esc(.ei$sys), '"},',
    '{"role":"user","content":"', .ei$esc(user), '"}]}')
  tmp <- tempfile(); writeLines(body, tmp); on.exit(unlink(tmp))
  out <- suppressWarnings(system2("curl",
    c("-s", "--max-time", "60", shQuote(.ei$url),
      "-H", shQuote(paste0("Authorization: Bearer ", .ei$key)),
      "-H", shQuote("Content-Type: application/json"),
      "-d", shQuote(paste0("@", tmp))),
    stdout = TRUE))
  out <- paste(out, collapse = "\n")
  code <- system2("jq", c("-r", shQuote(".choices[0].message.content // empty")),
                  input = out, stdout = TRUE)
  code <- paste(code, collapse = "\n")
  code <- gsub("^```[a-z]*\n?|```$", "", trimws(code))
  trimws(code)
}

.ei$run <- function(src) {
  exprs <- tryCatch(parse(text = src), error = function(e) e)
  if (inherits(exprs, "error")) {
    message("ei: generated code does not parse: ", conditionMessage(exprs))
    return(invisible())
  }
  for (ex in exprs) {
    res <- withVisible(eval(ex, envir = globalenv()))
    if (res$visible) {
      out <- capture.output(print(res$value))
      cat(out, sep = "\n")
      .ei$log <<- c(.ei$log, head(out, 10))
    }
  }
}

ei_repl <- function() {
  cat("ei: natural language R. English lines translate; R lines run as usual.\n")
  buf <- character()
  empties <- 0
  repeat {
    prompt <- if (length(buf) > 0) "+ " else "> "
    line <- tryCatch(readline(prompt),
                     interrupt = function(e) { buf <<- character(); "" })
    if (identical(line, "") && length(buf) == 0) {
      empties <- empties + 1
      if (empties > 50) break   # stdin closed (EOF floods empty lines)
      next
    }
    empties <- 0
    forced <- grepl("^\\s*,", line)
    buf <- c(buf, line)
    src <- paste(buf, collapse = "\n")
    if (!forced) {
      parsed <- tryCatch(parse(text = src), error = function(e) e)
      if (!inherits(parsed, "error")) {
        buf <- character()
        .ei$log <- c(.ei$log, paste0("> ", src))
        tryCatch(.ei$run(src), error = function(e)
          message("Error: ", conditionMessage(e)))
        next
      }
      if (grepl("unexpected end of input", conditionMessage(parsed))) next
    }
    # natural language
    buf <- character()
    intent <- sub("^\\s*,\\s*", "", src)
    intent <- gsub('^"|"$', "", intent)
    .ei$log <- c(.ei$log, paste0("> ", intent))
    code <- tryCatch(.ei$translate(intent), error = function(e) "")
    if (!nzchar(code)) { message("ei: translation failed"); next }
    cat("\033[2m= ", gsub("\n", "\n= ", code), "\033[0m\n", sep = "")
    if (.ei$guard && grepl(.ei$danger, code)) {
      reply <- readline("ei: this looks destructive. run it? [y/N] ")
      if (!tolower(reply) %in% "y") { message("ei: skipped"); next }
    }
    .ei$log <- c(.ei$log, paste0("= ", code))
    tryCatch(.ei$run(code), error = function(e)
      message("Error: ", conditionMessage(e)))
  }
}
