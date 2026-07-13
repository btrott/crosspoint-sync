#!/usr/bin/env bash
# End-to-end smoke test against a running crosspoint-sync server.
# Usage: scripts/curl-smoke.sh [base-url]   (default http://localhost:8080)
set -euo pipefail

BASE="${1:-http://localhost:8080}"
SMOKE_USER="smoke-$RANDOM"
KEY=$(printf '%s' 'smoke-password' | { md5sum 2>/dev/null || md5; } | cut -d' ' -f1 | tr -d ' -')
DOC="a1b2c3d4e5f60718293a4b5c6d7e8f90"

step() { printf '\n== %s\n' "$1"; }
check() { # check <expected-substring> <actual>
  if [[ "$2" != *"$1"* ]]; then
    echo "FAIL: expected '$1' in: $2" >&2
    exit 1
  fi
  echo "$2"
}
req() { # req <method> <path> [body]
  local method="$1" path="$2" body="${3:-}"
  if [[ -n "$body" ]]; then
    curl -sf -X "$method" "$BASE$path" \
      -H "x-auth-user: $SMOKE_USER" -H "x-auth-key: $KEY" \
      -H 'content-type: application/json' -d "$body"
  else
    curl -sf -X "$method" "$BASE$path" \
      -H "x-auth-user: $SMOKE_USER" -H "x-auth-key: $KEY" \
      -H 'content-type: application/json'
  fi
}

step "healthz"
check '"status":"ok"' "$(curl -sf "$BASE/healthz")"

step "register $SMOKE_USER"
BODY='{"username":"'$SMOKE_USER'","password":"'$KEY'"}'
check '"username":"'$SMOKE_USER'"' "$(curl -sf -X POST "$BASE/users/create" -H 'content-type: application/json' -d "$BODY")"

step "auth"
check '"authorized":"OK"' "$(req GET /users/auth)"

step "kosync PUT progress (with rich position superset)"
BODY='{"document":"'$DOC'","progress":"/body/DocFragment[8]/body/p[4]/text().96","percentage":0.4867,"device":"smoke","device_id":"smoke-a","position":{"pctQ":486700,"spine":7,"page":143,"pages":412,"para":96,"anchor":"ch8"}}'
check '"document":"'$DOC'"' "$(req PUT /syncs/progress "$BODY")"

step "kosync GET progress"
check '"percentage":0.4867' "$(req GET "/syncs/progress/$DOC")"

step "v1 GET progress (per-device, position captured)"
check '"pctQ":486700' "$(req GET "/api/v1/progress/$DOC")"

step "bookmarks: upsert + list + tombstone"
BODY='{"items":[{"id":"9f86d081884c7d65","xpath":"/body/DocFragment[3]/body/p[12]/text().0","percentage":0.35,"summary":"smoke","si":3,"pc":120,"pp":42}]}'
check '"accepted":1' "$(req PUT "/api/v1/bookmarks/$DOC" "$BODY")"
check '"summary":"smoke"' "$(req GET "/api/v1/bookmarks/$DOC")"
BODY='{"items":[{"id":"9f86d081884c7d65","deleted":1}]}'
check '"accepted":1' "$(req PUT "/api/v1/bookmarks/$DOC" "$BODY")"
check '"deleted":1' "$(req GET "/api/v1/bookmarks/$DOC")"

step "clippings: upsert + list"
BODY='{"items":[{"id":"c0ffee0011223344","spine":7,"start_page":12,"end_page":13,"pages":40,"start_word":5,"end_word":22,"words":30,"para":96,"chapter":"Chapter 8","text":"So we beat on, boats against the current.","created_at":1752300000}]}'
check '"accepted":1' "$(req PUT "/api/v1/clippings/$DOC" "$BODY")"
check '"chapter":"Chapter 8"' "$(req GET "/api/v1/clippings/$DOC")"

step "stats: global snapshot + book snapshot + summary"
HIST='BwAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA='
BODY='{"device_id":"smoke-a","device":"smoke","v":5,"sessions":312,"seconds":184300,"pages":9120,"completed":14,"tod":[1200,84000,60100,39000],"dow":[8000,9000,7000,11000,12000,60000,77300],"anchor_day":9650,"history_b64":"'$HIST'","streak":21}'
check '"until"' "$(req PUT /api/v1/stats/global "$BODY")"
BODY='{"device_id":"smoke-a","items":[{"document":"'$DOC'","v":5,"sessions":9,"seconds":8400,"pages":310,"completed":false,"avg_fwd":12,"pace_n":250,"eta":5400,"start_manual":false,"finish_manual":false,"start_date":1751000000,"finished_date":0,"tod":[0,3000,4000,1400],"dow":[0,0,1200,0,2000,3000,2200]}]}'
check '"accepted":1' "$(req PUT /api/v1/stats/books "$BODY")"
check '"sessions":312' "$(req GET /api/v1/stats/summary)"
check '"combined"' "$(req GET "/api/v1/stats/books/$DOC")"

step "documents metadata"
BODY='{"items":[{"document":"'$DOC'","title":"The Great Gatsby","author":"F. Scott Fitzgerald","filesize":812345}]}'
check '"accepted":1' "$(req PUT /api/v1/documents "$BODY")"

printf '\nALL SMOKE TESTS PASSED\n'
