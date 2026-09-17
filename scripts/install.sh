#!/usr/bin/env bash
# Install herdr-web: herdr reachable from a browser (iPad Safari) over the
# tailnet, via ttyd on loopback fronted by `tailscale serve`.
#
# Why this works at all with so little code: herdr is already client/server.
# `herdr server` runs detached (reparented to PID 1), owns every pane, and
# persists layout to ~/.config/herdr/session.json; bare `herdr` is a thin
# client over ~/.config/herdr/herdr-client.sock that can detach freely. So ttyd
# only has to host a disposable herdr *client* in a PTY — close the browser and
# the server plus every agent in it keeps running, exactly like SSH + reattach.
# Nothing about herdr is modified and no herdr state lives in the web layer.
#
# Runs as a `systemd --user` service rather than system-level: ttyd itself
# lives in /usr/bin but execs ~/.local/bin/herdr, and SELinux's targeted policy
# denies a system service (running under init_t) "execute" on $HOME. A --user
# unit runs in a context that doesn't hit it and needs no relabeling.
set -euo pipefail
BUNDLE_DIR="$(cd "$(dirname "$0")/.." && pwd)"

PORT=7681          # ttyd, loopback only
TAILNET_PORT=8444  # see the comment in the tailscale serve section — load-bearing
SHARE_DIR="$HOME/.local/share/herdr-web"

# Pinned deliberately. The browser loads nothing from the network at runtime
# (same posture as bridge/watchtower.html); these are fetched once here and
# inlined into the page, so an upstream change can't alter a live deploy.
XTERM_VER=5.5.0
FIT_VER=0.10.0

echo "== Prerequisites =="
if ! command -v ttyd >/dev/null; then
  sudo dnf install -y ttyd
else
  echo "ttyd already installed ($(ttyd --version 2>&1 | head -1)) — leaving as-is."
fi
command -v npm >/dev/null || { echo "npm is required to vendor xterm.js" >&2; exit 1; }
[ -x "$HOME/.local/bin/herdr" ] || { echo "~/.local/bin/herdr not found — install herdr first: curl -fsSL https://herdr.dev/install.sh | sh" >&2; exit 1; }

echo "== Vendor xterm.js (${XTERM_VER}) + addon-fit (${FIT_VER}) =="
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

fetch_pkg() {  # $1 = npm spec, $2 = destination dir
  local tgz
  tgz="$(cd "$TMP" && npm pack --silent "$1")"
  mkdir -p "$2"
  tar -xzf "$TMP/$tgz" -C "$2" --strip-components=1
}
fetch_pkg "@xterm/xterm@${XTERM_VER}" "$TMP/xterm"
fetch_pkg "@xterm/addon-fit@${FIT_VER}" "$TMP/fit"

XTERM_JS="$TMP/xterm/lib/xterm.js"
XTERM_CSS="$TMP/xterm/css/xterm.css"
FIT_JS="$TMP/fit/lib/addon-fit.js"
for f in "$XTERM_JS" "$XTERM_CSS" "$FIT_JS"; do
  [ -s "$f" ] || { echo "expected vendored file missing or empty: $f (did the package layout change?)" >&2; exit 1; }
done

echo "== Generate the self-contained page =="
# ttyd's -I/--index takes a single file and explicitly rejects a directory
# (src/server.c, case 'I'); sibling assets are not served. Hence one inlined
# file rather than a page plus <script src>. python3 (stdlib, system 3.14) does
# the splice because the payloads are full of characters sed would mangle.
mkdir -p "$SHARE_DIR"
python3 - "$BUNDLE_DIR/bridge/herdr-web.html.in" "$SHARE_DIR/index.html" \
  "$XTERM_CSS" "$XTERM_JS" "$FIT_JS" <<'PY'
import pathlib, sys
tmpl, out, css, js, fit = map(pathlib.Path, sys.argv[1:6])
html = tmpl.read_text()
for marker, src in (("@@XTERM_CSS@@", css), ("@@XTERM_JS@@", js), ("@@XTERM_FIT@@", fit)):
    if marker not in html:
        sys.exit(f"marker {marker} not found in {tmpl} — template and installer are out of sync")
    html = html.replace(marker, src.read_text())
out.write_text(html)
print(f"wrote {out} ({len(html):,} bytes)")
PY
chmod 644 "$SHARE_DIR/index.html"

echo "== Install systemd --user service =="
mkdir -p ~/.config/systemd/user
install -m644 "$BUNDLE_DIR/systemd/user/herdr-web.service" ~/.config/systemd/user/herdr-web.service
systemctl --user daemon-reload
systemctl --user enable --now herdr-web.service
systemctl --user restart herdr-web.service   # pick up a regenerated index.html
# Linger so the service survives logout/reboot without an active session.
loginctl enable-linger "$USER" 2>/dev/null || sudo loginctl enable-linger "$USER"

echo "== Waiting for ttyd =="
for _ in $(seq 1 15); do
  curl -fsS "http://127.0.0.1:$PORT/" >/dev/null 2>&1 && break
  sleep 1
done
# Probe for a string only OUR page contains. A plain 200 would also be returned
# by ttyd's built-in frontend, which would mean --index silently didn't take and
# the key bar (the entire point on an iPad) is missing.
# Captured to a variable rather than piped into `grep -q`: grep exits on the
# first match, curl then dies writing to a closed pipe, and `set -o pipefail`
# turns that into a spurious install failure.
PAGE="$(curl -fsS "http://127.0.0.1:$PORT/" || true)"
case "$PAGE" in
  *'id="bar"'*) echo "ttyd up on 127.0.0.1:$PORT, serving the custom herdr-web page." ;;
  *) echo "ttyd did not serve the custom page — check: journalctl --user -u herdr-web.service" >&2; exit 1 ;;
esac

# Confirm the loopback-only bind actually held. This is the security property the
# whole design rests on — nothing authenticates in front of this shell — so
# assert it rather than assume it. Note both halves matter: a missing listener
# must fail too, or the check passes vacuously when ttyd isn't running at all.
LISTEN="$(ss -tlnH "sport = :$PORT" | awk '{print $4}')"
if [ -z "$LISTEN" ]; then
  echo "REFUSING: nothing is listening on :$PORT — ttyd failed to bind." >&2
  exit 1
fi
if [ -n "$(printf '%s\n' "$LISTEN" | grep -v '^127\.0\.0\.1:' || true)" ]; then
  echo "REFUSING: ttyd is listening somewhere other than 127.0.0.1 — this endpoint is an unauthenticated shell." >&2
  ss -tlnp "sport = :$PORT" >&2
  exit 1
fi
echo "Bind confirmed loopback-only ($LISTEN)."

echo "== Tailscale serve (tailnet-only HTTPS) =="
# TAILNET_PORT=8444 is a deliberate choice, not an arbitrary free port. This
# tailnet's capability map limits Funnel to ports 443, 8443 and 10000, so 8444
# is STRUCTURALLY ineligible for Funnel — no later `tailscale funnel` mistake
# can publish an unauthenticated root-capable shell to the internet. 8443 looks
# like the more natural number and would quietly give up that guarantee.
# Do not "tidy" this to 8443.
if ! command -v tailscale >/dev/null || ! tailscale status >/dev/null 2>&1; then
  echo "Tailscale not running — skipping tailnet exposure. Service is live on 127.0.0.1:$PORT only." >&2
else
  DNSNAME="$(tailscale status --json | python3 -c 'import json,sys; print(json.load(sys.stdin)["Self"]["DNSName"].rstrip("."))')"

  # Register the herdr-web endpoint. If you have other serve entries from
  # a prior install, re-register them manually (the stale-entry cleanup
  # block was removed — it was machine-specific).
  tailscale serve --bg --https="$TAILNET_PORT" "http://127.0.0.1:$PORT"
  echo
  echo "herdr in the browser: https://${DNSNAME}:${TAILNET_PORT}"
fi

echo
echo "== Next steps =="
echo "  * Open the URL above in Safari on the iPad (tailnet only — no password by design;"
echo "    the tailnet's device identity IS the auth. Lost device => revoke its node key)."
echo "  * Verify: tailscale serve status   (expect an entry on :$TAILNET_PORT)"
echo "  * If you edit bridge/herdr-web.html.in, re-run this script — ttyd serves the"
echo "    generated $SHARE_DIR/index.html, not the repo copy."
