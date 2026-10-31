#!/usr/bin/env bash
#
# Run a wrangler deploy, retrying only a transient Cloudflare failure.
#
#   .github/scripts/deploy-with-retry.sh <wrangler command...>
#
# The command is taken from the caller so each workflow keeps its own
# invocation (`npx wrangler deploy --config wrangler.preview.jsonc` for a
# preview, `pnpm exec wrangler deploy --config wrangler.router.jsonc` with
# `--var` for production).
#
# Only three signals are retried, because retrying anything else triples the
# noise and delays the message that matters:
#
#   - `code: 10013`, the Cloudflare API's "unknown error" seen in #970
#   - an HTTP 5xx from the Cloudflare API
#   - a connection reset
#
# An expired per-attempt timeout is retried too: a hung upload is the case the
# timeout exists for, and failing on the first one would defeat it.
#
# Authentication failures, a missing environment and wrangler validation
# errors fail on the first attempt.
#
# Every attempt after the first is announced with a `::warning::` naming the
# attempt and the reason, so the flake rate stays visible in the Actions UI
# instead of disappearing behind a passing job.
#
# Environment:
#   DEPLOY_ATTEMPTS         total attempts (default 3)
#   DEPLOY_ATTEMPT_TIMEOUT  seconds allowed per attempt (default 180)
#   DEPLOY_BACKOFFS         seconds to wait before each retry (default "10 30")
set -uo pipefail

attempts=${DEPLOY_ATTEMPTS:-3}
attempt_timeout=${DEPLOY_ATTEMPT_TIMEOUT:-180}
read -r -a backoffs <<< "${DEPLOY_BACKOFFS:-10 30}"

if [ "$#" -eq 0 ]; then
  echo "usage: $0 <wrangler command...>" >&2
  exit 2
fi

if ! [[ "$attempts" =~ ^[1-9][0-9]*$ ]]; then
  echo "DEPLOY_ATTEMPTS must be a positive integer, got '$attempts'" >&2
  exit 2
fi

# `timeout` is coreutils: every GitHub runner has it, a stock macOS does not.
# Falling back keeps the script usable from a laptop (the unit suite runs it),
# and says so rather than silently dropping the bound. Bash 3.2 ships on macOS,
# so an empty array cannot be expanded with "${timeout_cmd[@]}" under `set -u`.
timeout_cmd=()
if command -v timeout >/dev/null 2>&1; then
  timeout_cmd=(timeout --kill-after=10 "$attempt_timeout")
elif command -v gtimeout >/dev/null 2>&1; then
  timeout_cmd=(gtimeout --kill-after=10 "$attempt_timeout")
else
  echo "::warning::no 'timeout' or 'gtimeout' on PATH — deploy attempts are not bounded (install coreutils to restore the per-attempt limit)"
fi

logs=$(mktemp -d)
trap 'rm -rf "$logs"' EXIT

# Echo the transient reason found in an attempt's output, or return 1 when the
# failure is one we must not retry.
transient_reason() {
  local log=$1
  local http

  if grep -qE 'code: ?10013' "$log"; then
    printf 'Cloudflare API error code 10013'
    return 0
  fi
  http=$(grep -oE 'HTTP 5[0-9][0-9]' "$log" | head -1 || true)
  if [ -n "$http" ]; then
    printf '%s from the Cloudflare API' "$http"
    return 0
  fi
  if grep -qiE 'ECONNRESET|connection reset|socket hang up' "$log"; then
    printf 'connection reset'
    return 0
  fi

  return 1
}

for (( attempt = 1; attempt <= attempts; attempt++ )); do
  log="$logs/attempt-$attempt.log"
  status=0
  echo "deploy attempt $attempt/$attempts: $*"
  # The whole attempt is bounded: an upload that stops making progress must not
  # hold the job until the workflow's own timeout. `--kill-after` covers a
  # process that ignores TERM. Without coreutils the bound is dropped and the
  # warning above says so, rather than turning every deploy into exit 127.
  ${timeout_cmd[@]+"${timeout_cmd[@]}"} "$@" >"$log" 2>&1 || status=$?
  cat "$log"

  if [ "$status" -eq 0 ]; then
    echo "deploy succeeded on attempt $attempt/$attempts"
    exit 0
  fi

  reason=$(transient_reason "$log") || reason=
  if [ -z "$reason" ]; then
    if [ "$status" -eq 124 ] || [ "$status" -eq 137 ]; then
      reason="attempt timed out after ${attempt_timeout}s"
    else
      echo "::error::deploy failed on attempt $attempt/$attempts with a non-transient error (exit $status) — not retrying" >&2
      tail -n 30 "$log" >&2
      exit "$status"
    fi
  fi

  if [ "$attempt" -ge "$attempts" ]; then
    echo "::error::deploy failed after $attempts attempts — last failure: $reason" >&2
    tail -n 30 "$log" >&2
    exit "$status"
  fi

  delay=${backoffs[$((attempt - 1))]:-0}
  echo "::warning::wrangler deploy attempt $((attempt + 1))/$attempts after attempt $attempt/$attempts failed with: $reason — waiting ${delay}s"
  if [ "$delay" -gt 0 ]; then
    sleep "$delay"
  fi
done
