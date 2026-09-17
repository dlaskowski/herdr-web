herdr-web — Browser terminal for herdr
=======================================

Serve herdr in a browser so you can run herdr from an iPad, phone, or any
device with a web browser. The browser talks to ttyd on loopback; ttyd runs
a disposable herdr client in a PTY. The only external route is Tailscale —
no password is needed because the Tailscale network identity IS the
authentication.

What you get
------------

  * A full herdr session in Safari (or any browser) via https://<your-host>:8444
  * An on-screen key bar for esc, ctrl, tab, shift+tab, arrows, and paste —
    the iPad on-screen keyboard has none of these
  * Voice dictation that works correctly on iOS (the tricky part: iOS
    dictation re-sends the entire phrase as it revises, which was broken in
    early versions)
  * Touch-scrolling the terminal (drag to scroll herdr's pane)
  * Copy/paste support (both directions)
  * Auto-reconnect if the network blinks

Architecture
------------

  User's browser
       |
  Tailscale serve (:8444)  <-- HTTPS, tailnet only
       |
  ttyd (port 7681, loopback only)
       |
  ~/.local/bin/herdr (a disposable herdr CLIENT in a PTY)
       |
  herdr server (detached, persists workspaces/agents)

Closing the browser kills only the disposable client; herdr's detached
server and every running agent keep running. This is like SSH + detach.

Prerequisites
-------------

  1. A Linux box running Fedora (or compatible). The script uses `dnf` to
     install ttyd and expects systemd --user services.
  2. The `herdr` binary installed at `~/.local/bin/herdr`.
     Install from: curl -fsSL https://herdr.dev/install.sh | sh
  3. `npm` installed (used once to vendor xterm.js).
  4. Tailscale installed and running (provides the HTTPS endpoint).
  5. `python3` available (stdlib, for the template splicing step).
  6. `loginctl` available (for enabling linger so services survive logout).

Installation
------------

  1. Clone or download this package to your machine:
       git clone <repo> ~/jarvis-setup
     (or extract the tarball and note the directory path)

  2. Run the installer:
       bash ~/jarvis-setup/scripts/96-install-herdr-web.sh

     The script does all of the following automatically:
       * Installs ttyd via dnf (if not already present)
       * Vendors xterm.js 5.5.0 and addon-fit 0.10.0
       * Generates a self-contained index.html at
         ~/.local/share/herdr-web/index.html
       * Installs the systemd --user service
       * Enables linger for your user
       * Registers the Tailscale serve endpoint on :8444

  3. The service is live immediately. Find your URL in the script output,
     or run:
       tailscale serve status

Usage
-----

  1. Open https://<your-tailscale-hostname>:8444 in Safari on your iPad.
     The tailnet's device identity is the authentication — no password.

  2. If you lost the device, revoke its node key in the Tailscale admin
     console to invalidate access.

  3. Use the on-screen key bar for esc, ctrl, tab, arrows, and paste.
     Tap the terminal to focus it and bring up the keyboard.

  4. Dictation: tap the microphone button in Safari. The page handles
     iOS's phrase re-submission correctly — no duplication.

  5. To debug input issues, append ?debug to the URL. This shows a
     real-time log of all input events (speech, mouse, keystrokes).

  6. Touch-scrolling: drag up/down on the terminal to scroll the pane.

Updating the page
-----------------

  If you edit bridge/herdr-web.html.in, re-run the installer script:
    bash ~/jarvis-setup/scripts/96-install-herdr-web.sh

  ttyd serves the GENERATED page (~/.local/share/herdr-web/index.html),
  not the repo copy, so edits alone don't change the running page.

Troubleshooting
---------------

  * "Connection refused" or "disconnected":
    Check the service: systemctl --user status herdr-web.service
    Then: journalctl --user -u herdr-web.service

  * The key bar is missing from the browser:
    ttyd is likely serving its default page, not the generated one.
    Re-run the installer script.

  * Dictation still duplicates text:
    Open the URL with ?debug and copy the event log. Check that
    xterm.js loaded (the page should have no errors). If needed,
    re-run the installer to refresh the vendored xterm.js.

  * Can't reach the URL from another device on the tailnet:
    Make sure Tailscale is running on both devices:
      tailscale status
    The serve endpoint uses the machine's Tailscale IP + :8444.

Security notes
--------------

  * ttyd binds ONLY to 127.0.0.1 — no other interface can reach it.
  * The Tailscale serve endpoint on :8444 CANNOT be exposed to the
    internet (Funnel is capped to 443/8443/10000; 8444 is structurally
    ineligible). This prevents accidental public exposure.
  * There is no authentication in front of the shell — the trust model
    is Tailscale device identity. If a device is compromised, revoke its
    node key.

File layout
-----------

  scripts/96-install-herdr-web.sh    — installer (run once)
  bridge/herdr-web.html.in           — page template
  systemd/user/herdr-web.service     — systemd unit
  ~/.local/share/herdr-web/index.html — generated page (do not edit)
  ~/.config/systemd/user/herdr-web.service — deployed unit (do not edit)

License
-------

  herdr-web.html.in:
    Copyright (c) 2014 The xterm.js authors (MIT)
    Copyright (c) 2012-2013 Christopher Jeffrey (MIT)
    Copyright (c) 2025 Nous Research / herdr contributors

  Installer and systemd unit: same license as the herdr project.
