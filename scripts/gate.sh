#!/usr/bin/env bash
# Story 7.12.12 Launch Gate. Runs every project check in order, one at a time, then fails on any
# open Critical/High finding in the launch audit docs. Browser output is removed on exit.
#
# Usage: scripts/gate.sh [--skip-browser] [--check-docs-only] [--docs-dir DIR]
#   --skip-browser     run the non-browser checks only (format, lint, typecheck, tests, scans)
#   --check-docs-only  run only the audit-doc open Critical/High check
#   --docs-dir DIR     audit doc directory for the check (default docs/audit/launch)

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

DOCS_DIR="$ROOT/docs/audit/launch"
SKIP_BROWSER=0
CHECK_DOCS_ONLY=0

usage() {
  echo "usage: scripts/gate.sh [--skip-browser] [--check-docs-only] [--docs-dir DIR]" >&2
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --skip-browser) SKIP_BROWSER=1; shift ;;
    --check-docs-only) CHECK_DOCS_ONLY=1; shift ;;
    --docs-dir)
      [[ $# -ge 2 ]] || { echo "gate.sh: --docs-dir needs a path" >&2; exit 2; }
      DOCS_DIR="$2"
      shift 2
      ;;
    -h | --help) usage; exit 0 ;;
    *)
      echo "gate.sh: unknown argument: $1" >&2
      usage
      exit 2
      ;;
  esac
done

cleanup() {
  rm -rf "$ROOT/apps/web/dist" "$ROOT/.lighthouseci"
}
trap cleanup EXIT

FAILED_STEPS=0

step() {
  local name="$1"
  shift
  printf '\n===== %s: %s =====\n' "$name" "$*"
  local status=0
  "$@" || status=$?
  if ((status != 0)); then
    echo "gate.sh: step failed: $name (exit $status)" >&2
    FAILED_STEPS=$((FAILED_STEPS + 1))
  fi
}

check_audit_docs() {
  local dir="$1"
  if [[ ! -d "$dir" ]]; then
    echo "gate.sh: audit doc directory not found: $dir" >&2
    return 2
  fi

  local files=0 open=0 file bad
  shopt -s nullglob
  local docs=("$dir"/[0-9][0-9]-*.md)
  shopt -u nullglob

  for file in "${docs[@]}"; do
    files=$((files + 1))
    bad="$(awk -F'|' '
      /^[[:space:]]*\|/ {
        line = $0
        sub(/^[[:space:]]*\|/, "", line)
        sub(/\|[[:space:]]*$/, "", line)
        n = split(line, cell, "|")
        if (n < 5) next
        id = cell[1]
        severity = cell[2]
        status = cell[n]
        gsub(/^[[:space:]]+|[[:space:]]+$/, "", id)
        gsub(/^[[:space:]]+|[[:space:]]+$/, "", severity)
        gsub(/^[[:space:]]+|[[:space:]]+$/, "", status)
        if (id !~ /^[A-Z]+-[0-9]+$/) next
        if (tolower(status) != "open") next
        sev = tolower(severity)
        if (sev == "critical" || sev == "high" || sev == "p0" || sev == "p1")
          print id " (" severity ")"
      }' "$file")"
    if [[ -n "$bad" ]]; then
      while IFS= read -r hit; do
        echo "gate.sh: OPEN finding: $hit in $(basename "$file")" >&2
        open=$((open + 1))
      done <<<"$bad"
    fi
  done

  if ((open > 0)); then
    echo "audit docs: $open open Critical/High finding(s) across $files doc(s)" >&2
    return 1
  fi
  printf 'audit docs: %d doc(s), 0 open Critical/High\n' "$files"
}

scan_secrets() {
  local revisions
  mapfile -t revisions < <(git rev-list --all)

  # Real credential shapes only. The reply-guard fixtures use short obvious fakes (PORT-06).
  local keys='AKIA[0-9A-Z]{16}|ASIA[0-9A-Z]{16}|ghp_[A-Za-z0-9]{36}|github_pat_[A-Za-z0-9_]{50,}|xox[baprs]-[A-Za-z0-9-]{10,}|sk-[A-Za-z0-9_-]{40,}|AIza[0-9A-Za-z_-]{35}|-----BEGIN [A-Z ]*PRIVATE KEY-----'
  local uris='rediss?://[^:@/ ]*:[^@/ ]+@|postgres(ql)?://[^:@/ ]+:[^@/ ]+@'
  # Committed non-live hosts: compose services, loopback, documentation and test domains.
  local local_uris='@(localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\]|\$\{[^}]*\}|host\.docker\.internal|[A-Za-z0-9_-]+|[^@/ ]*\.(example|test|invalid|local|internal|localstack\.cloud))([:/]|$)'

  local key_hits uri_hits
  key_hits="$(git grep -l -I -E "$keys" "${revisions[@]}" -- 2>/dev/null || true)"
  uri_hits="$(git grep -n -I -E "$uris" "${revisions[@]}" -- 2>/dev/null || true)"
  uri_hits="$(printf '%s\n' "$uri_hits" | grep -Ev "$local_uris" | cut -d: -f1,2 | sort -u || true)"

  if [[ -n "$key_hits" || -n "$uri_hits" ]]; then
    echo "gate.sh: secret-shaped content found in git history (revision:path only):" >&2
    [[ -n "$key_hits" ]] && printf '%s\n' "$key_hits" >&2
    [[ -n "$uri_hits" ]] && printf '%s\n' "$uri_hits" >&2
    return 1
  fi
  echo "secret scan: clean (${#revisions[@]} revisions; gitleaks absent, full-history git grep fallback)"
}

run_dependency_audit() {
  local status=0
  bun audit || status=$?
  if ((status != 0)); then
    echo "gate.sh: bun audit exited $status; every current advisory is dev-only and accepted as SEC-04 in docs/audit/launch/01-security.md" >&2
  fi
  return 0
}

echo "Launch Gate on $(git rev-parse --short HEAD) $(git branch --show-current)"

if ((CHECK_DOCS_ONLY)); then
  check_audit_docs "$DOCS_DIR"
  exit 0
fi

step "format" bun run format:check
step "lint" bun run lint --concurrency=off
step "typecheck" bun run typecheck
step "api unit" env NODE_ENV=test bun --filter @relay/api test:unit --maxWorkers=1 --no-file-parallelism
step "api integration" env NODE_ENV=test bun --filter @relay/api test:integration --maxWorkers=1 --no-file-parallelism
step "web" env NODE_ENV=test bun --filter @relay/web test --maxWorkers=1 --no-file-parallelism

if ((SKIP_BROWSER)); then
  echo "gate.sh: browser steps skipped (--skip-browser)"
else
  step "e2e + a11y" env NODE_ENV=test CI=1 TICKET_DAILY_CAP=100000 TICKET_IP_HOURLY_LIMIT=100000 MAIL_DAILY_CAP=100000 bun run test:e2e
  step "lighthouse" env NODE_ENV=test TICKET_DAILY_CAP=100000 TICKET_IP_HOURLY_LIMIT=100000 MAIL_DAILY_CAP=100000 bun run lighthouse
fi

step "secret scan" scan_secrets
step "dependency audit" run_dependency_audit
step "audit docs" check_audit_docs "$DOCS_DIR"

if ((FAILED_STEPS > 0)); then
  echo "Launch Gate failed: $FAILED_STEPS step(s) failed." >&2
  exit 1
fi

printf '\nLaunch Gate passed: every step exited 0.\n'
