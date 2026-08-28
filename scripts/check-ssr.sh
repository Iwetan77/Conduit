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
# to appear nowhere in the layout.
#
# Matched on the PATH alone, so the host and any query string cannot affect the
# choice. Deriving the path first is what makes the "/" case expressible: keyed
# off the whole URL, "is this the landing page" and "is this any URL at all"
# are the same glob.
if [ -z "$MARKER" ]; then
  URL_PATH="${URL#*://}"        # drop scheme
  URL_PATH="/${URL_PATH#*/}"    # drop host, keep a leading slash
  [ "$URL_PATH" = "/${URL#*://}" ] && URL_PATH="/"   # no path at all
  URL_PATH="${URL_PATH%%\?*}"   # drop query
  URL_PATH="${URL_PATH%/}"      # drop one trailing slash
  case "$URL_PATH" in
    "")                MARKER="Send &amp; Scan to Pay" ;;  # landing hero
    /send|/send/*)     MARKER="Pay anyone in the currency they want" ;;
    /docs|/docs/*)     MARKER="Quickstart" ;;
    /pay/*)            MARKER="Powered by" ;;
    /history)          MARKER="History" ;;
    /links)            MARKER="Links" ;;
    /create)           MARKER="Create Payment" ;;
    # An unmapped path used to fall through to the landing page's hero string,
    # so it reported "body did not server-render" for a page that had rendered
    # perfectly -- the marker was simply being looked for in the wrong page. A
    # check that cries wolf gets read as a real regression and costs a
    # debugging session, so say what is actually wrong instead: nobody told it
    # what to look for. Exit 2, distinct from a real failure's 1.
    *)
      echo "SKIP  $URL — no marker mapped for $URL_PATH." >&2
      echo "      Pass one explicitly: $0 $URL \"some string the page body renders\"" >&2
      exit 2
      ;;
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
