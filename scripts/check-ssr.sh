#!/usr/bin/env bash
# Assert that a page arrives with its BODY already rendered, not as an empty
# shell that fills in after hydration.
#
# This exists because the whole app was, for a long time, the second thing:
# every child of the root layout sat inside a dynamic(ssr:false) wrapper, so
# every route shipped chrome and nothing else and painted its content only once
# JavaScript had downloaded, parsed and run. Nothing in a normal build catches
# that -- the page works, it is just late, and every loading boundary in the
# codebase is dead weight because there is no server render for them to cover.
#
# So the test is deliberately crude and hard to fool: fetch the HTML with no
# JavaScript anywhere in sight, and look for a string that only the page body
# can produce. Chrome from the layout does not count.
#
# Usage:
#   ./scripts/check-ssr.sh http://localhost:3000/send
#   ./scripts/check-ssr.sh http://localhost:3000/pay/pl_test "Powered by"
#
# Exit 0 = the marker was in the server HTML. Exit 1 = it was not.
set -uo pipefail

URL="${1:-}"
MARKER="${2:-}"

if [ -z "$URL" ]; then
  echo "usage: $0 <url> [marker]" >&2
  exit 2
fi

# Markers are strings rendered by the page's own body, chosen to be stable and
# to appear nowhere in the layout. Matched on the PATH so any host works.
if [ -z "$MARKER" ]; then
  case "$URL" in
    */send|*/send/*|*/send\?*)   MARKER="Pay anyone in the currency they want" ;;
    */docs|*/docs/*)             MARKER="Quickstart" ;;
    */pay/*)                     MARKER="Powered by" ;;
    */history|*/history/*)       MARKER="History" ;;
    */links|*/links/*)           MARKER="Links" ;;
    *)                           MARKER="Send &amp; Scan to Pay" ;;  # landing hero
  esac
fi

BODY="$(curl -sS --max-time 30 -H 'Accept: text/html' "$URL" 2>/dev/null)"
CURL_RC=$?

if [ $CURL_RC -ne 0 ] || [ -z "$BODY" ]; then
  echo "FAIL  $URL — no response (curl exit $CURL_RC)"
  exit 1
fi

if printf '%s' "$BODY" | grep -qF -- "$MARKER"; then
  echo "ok    $URL — server-rendered (found: \"$MARKER\")"
  exit 0
fi

echo "FAIL  $URL — body did not server-render"
echo "      expected to find: \"$MARKER\""
echo "      response was ${#BODY} bytes"
# The most useful thing to see next is whether ANY body content came through,
# so print the first heading-ish text the HTML does contain.
FOUND="$(printf '%s' "$BODY" | grep -oE '<(h1|h2|title)[^>]*>[^<]{3,80}' | head -3)"
if [ -n "$FOUND" ]; then
  echo "      HTML did contain:"
  printf '        %s\n' "$FOUND"
else
  echo "      HTML contained no headings at all — this is the empty-shell case."
fi
exit 1
