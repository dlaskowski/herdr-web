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

  1. A Linux box running Fedora/RHEL or Debian/Ubuntu. The script reads
     /etc/os-release and installs ttyd with `dnf` or `apt-get` accordingly,
     and expects systemd --user services.
  2. The `herdr` binary installed at `~/.local/bin/herdr`.
     Install from: curl -fsSL https://herdr.dev/install.sh | sh
  3. `npm` (optional — used once to vendor xterm.js; without it the
     installer downloads the same tarballs from the npm registry with curl).
  4. Tailscale installed, logged in, and running (provides the HTTPS
     endpoint). Your user must be a Tailscale operator so the installer can
     run `tailscale serve` without sudo:
       sudo tailscale set --operator=$USER
     Serve (HTTPS certificates) must be enabled for the tailnet; the first
     `tailscale serve` prints a link to enable it if it isn't.
  5. `python3` available (stdlib, for the template splicing step).
  6. `loginctl` available (for enabling linger so services survive logout).

Installation
------------

  1. Clone or download this package to your machine:
       git clone <repo> ~/.local/share/herdr-web-installer
     (or extract the tarball and note the directory path)

  2. Run the installer:
       bash ~/.local/share/herdr-web-installer/scripts/install.sh

     The script does all of the following automatically:
       * Installs ttyd via dnf or apt-get (if not already present)
       * Disables the distro's own system ttyd.service if one is running
         (Debian/Ubuntu's package starts one on port 7681)
       * Vendors xterm.js 5.5.0 and addon-fit 0.10.0
       * Generates a self-contained index.html at
         ~/.local/share/herdr-web/index.html
       * Installs the systemd --user service
       * Enables linger for your user
       * Registers the Tailscale serve endpoint on :8444

  3. The service is live immediately. Find your URL in the script output,
     or run:
       tailscale serve status

Choosing a different port
-------------------------

  The tailnet endpoint defaults to :8444. If something else on the machine
  already listens there, the installer stops before changing anything. Pick
  another port with HERDR_WEB_PORT:

    HERDR_WEB_PORT=8445 bash scripts/install.sh

  or, to make it stick for this machine, put it in an untracked .env at the
  repo root (see .env.example):

    echo 'HERDR_WEB_PORT=8445' > .env

  Avoid 443, 8443 and 10000 — those are the ports Funnel can publish to the
  internet, and staying off them is what keeps this shell tailnet-only.
  If you use the environment variable instead of .env, pass the same value
  every time you re-run the installer.

Debian / Ubuntu notes
---------------------

  * The ttyd package enables a system ttyd.service (a `login` prompt on
    127.0.0.1:7681). The installer disables it — it collides with herdr-web
    and is a root-owned shell endpoint you don't need.
  * On a server, consider `sudo tailscale up --operator=$USER
    --accept-dns=false` so Tailscale doesn't take over the host's DNS. If the
    machine sits on a subnet that another node advertises, leave
    --accept-routes off (the default on Linux).

Usage
-----

  1. Open https://<your-tailscale-hostname>:8444 (or your HERDR_WEB_PORT)
     in Safari on your iPad.
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
    bash ~/.local/share/herdr-web-installer/scripts/install.sh

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

  scripts/install.sh                 — installer (run once)
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
