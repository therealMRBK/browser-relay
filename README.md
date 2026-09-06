# desktop-relay

A full Linux desktop — Xvfb + Fluxbox + a real, normally-launched Google
Chrome — streamed to any browser as MJPEG over plain HTTP and controlled
via plain HTTP POSTs. **No WebSockets anywhere**, deliberately: built for
networks that block the WS protocol outright.

Because Chrome is launched like a normal desktop app instead of through
Playwright/CDP, it is never automation-flagged — the Chrome Web Store,
extensions, cookies, and logins all behave exactly like a real user's
browser, no automation-detection cat-and-mouse.

## Features

- Full remote desktop (not just one browser tab) — any app you install
  inside the container is visible and controllable
- Real Chrome, never CDP/automation-driven
- Live desktop stream via `ffmpeg -f x11grab` → MJPEG, `multipart/x-mixed-replace`
- Mouse and keyboard control (`xdotool`)
- Dynamic resolution — the virtual display resizes to match your browser
  window automatically
- Shared upload/download folder for file transfer with the remote desktop
- Zero WebSocket usage anywhere in the stack

## Quick start (one command)

Requires Docker and Docker Compose v2.

```bash
git clone https://github.com/therealMRBK/browser-relay.git && cd browser-relay && ./setup.sh
```

Opens on **http://localhost:8094** by default. First boot downloads Chrome
during the image build, so it can take a minute.

### Manual setup

```bash
git clone https://github.com/therealMRBK/browser-relay.git
cd browser-relay
cp .env.example .env   # optional: change port/resolution/fps
docker compose up -d --build
```

## Configuration

All configuration is via `.env` — see [`.env.example`](.env.example):

| Variable | Default | Purpose |
|---|---|---|
| `HOST_PORT` | `8094` | Port the web UI is exposed on |
| `DISPLAY_WIDTH` / `DISPLAY_HEIGHT` | `1920` / `1080` | Initial virtual display resolution (auto-resizes per viewer) |
| `TARGET_FPS` | `24` | Stream framerate |

Chrome's profile and the shared upload/download folder persist in the
`desktop-relay-data` Docker volume.

## ⚠️ Security

**This app has no built-in authentication or login screen.** Anyone who can
reach the exposed port gets a full, controllable desktop with internet
access. Do not expose it directly to the internet.

Put it behind an authenticating reverse proxy (e.g. nginx/Caddy with Basic
Auth or an access list) or a VPN before making it reachable from outside
your own machine or LAN.

## How it works

- **Display**: `Xvfb` provides the virtual X11 display; `Fluxbox` is a
  lightweight window manager on top of it.
- **Browser**: real `google-chrome-stable`, launched as a normal process —
  no `--enable-automation`, no CDP.
- **Streaming**: `ffmpeg -f x11grab` captures the X11 display and encodes it
  as an MJPEG stream (`-f mpjpeg`), which the server re-frames and relays to
  every connected client individually (pull-based — a slow client never
  builds up a backlog, it just gets the newest frame available).
- **Input**: mouse/keyboard events from the browser are translated to
  `xdotool` commands against the virtual display — this controls the whole
  desktop, not just one page.
- **Resize**: dragging/resizing the browser window triggers a real `xrandr`
  mode switch (not CSS scaling) so the remote desktop always renders at the
  viewer's actual pixel size.
- **File transfer**: uploads land in a shared folder (`/data/shared`) that's
  also set as Chrome's default download directory, so any app's file-open
  dialog can see files from either direction.

## Tech stack

Node.js 22 · Express · Xvfb · Fluxbox · ffmpeg · xdotool · Google Chrome

## License

MIT — see [LICENSE](LICENSE).
