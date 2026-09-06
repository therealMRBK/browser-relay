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
- **Discord and a terminal (xterm) come pre-installed**, launched on demand
  via the 🎮/⌨️ buttons in the corner of the page — see
  [Launching Discord/a terminal](#launching-discordaterminal) below
- Live desktop stream via `ffmpeg -f x11grab` → MJPEG, `multipart/x-mixed-replace`
- **Bidirectional audio**, also over plain HTTP: hear the remote desktop's
  sound (Chrome's audio → live Ogg/Opus stream), and send your own
  microphone to it (it shows up inside the container as the default mic —
  Discord, Meet, etc. just pick it up)
- Mouse and keyboard control (`xdotool`), full Unicode input including
  umlauts/accents (container locale is `de_DE.UTF-8`; Chrome's UI defaults
  to German — see [Configuration](#configuration) to change either)
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

The container's locale and Chrome's UI language are set to German
(`de_DE.UTF-8`, `--lang=de`) directly in the Dockerfile/`server.js` rather
than via `.env` — change the `LANG`/`LC_ALL`/`LANGUAGE` values in
`server.js`'s `childEnv` and the `--lang=de` Chrome flag if you want a
different locale. This isn't just cosmetic: without *any* UTF-8 locale
configured, `xdotool type` can't type multi-byte UTF-8 characters at all
(umlauts, accents, emoji) and fails outright — it's not merely a display
issue, so don't just drop this to fix "German by default" without picking
another real UTF-8 locale to replace it with.

Chrome's profile and the shared upload/download folder persist in the
`desktop-relay-data` Docker volume. Optional GPU passthrough for hardware
video decode (see `docker-compose.yml`'s `devices:` block) needs a host with
`/dev/dri` — remove that block if your host doesn't have one, Chrome falls
back to software decode automatically.

## Launching Discord/a terminal

There's no reachable taskbar or desktop right-click menu to launch other
apps from (Chrome fills the whole screen at all times), so Discord and
`xterm` are started via the two extra buttons in the top-right corner
instead (`POST /apps/launch`, body `{"app": "discord"}` or `{"app":
"terminal"}` — same mechanism if you ever want to add another app the same
way).

**First Discord launch takes 20-60+ seconds**: `/usr/bin/discord` is only a
bootstrapper, not the app itself — it downloads the real client from
Discord's update servers the first time, on every fresh container (this
isn't cached across container recreates, only within one container's
uptime). You may see a couple of small "profile in use?" dialog boxes pop up
during that first launch — they're leftover/informational from Discord's own
updater, not something blocking; the login screen behind them works
regardless, and you can close or ignore them. The window is auto-resized to
fill the screen once it appears, but keeps its normal title bar (unlike
Chrome, which is borderless) — drag it or use the maximize button if the
automatic sizing doesn't land right.

`xterm` opens as a normal, decorated, resizable window and gives you a real
root shell in the container (e.g. to poke around, install something else
ad-hoc, or check logs) — clicking the button again opens another one, there's
no limit.

## Updating an existing install

```bash
cd browser-relay
git pull
docker compose up -d --build
```

`up -d --build` rebuilds the image from the updated source and recreates
the container automatically if anything changed — no separate `down`/`up`
needed for ordinary code changes. Your Chrome profile, shared files, and
`.env` are untouched (they live in the `desktop-relay-data` volume and your
own `.env`, neither of which `git pull` or a rebuild touches).

Two exceptions where you *do* need an extra step:
- **`.env.example` gained a new variable you want to use**: `.env` isn't
  auto-updated (it's your own file, `git` never touches it) — add the new
  variable to your existing `.env` by hand, then `docker compose up -d --build`.
- **`docker-compose.yml` itself changed** (e.g. this update added the
  optional GPU `devices:` block): compare it against your local copy if
  you've customized it — `git pull` will merge or conflict depending on
  whether you've edited that specific file yourself.

If something seems stuck after updating (e.g. still on the old image),
force it explicitly:

```bash
docker compose down
docker compose up -d --build
```

## ⚠️ Security

**This app has no built-in authentication or login screen.** Anyone who can
reach the exposed port gets a full, controllable desktop with internet
access, can listen to its audio, can inject audio into its virtual
microphone, **and can open a root shell in the container via the terminal
button**. Do not expose it directly to the internet.

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
- **Audio out**: PulseAudio (`--system` mode) provides a virtual sink
  (`chrome_out`) as Chrome's default audio device. Its monitor is captured
  continuously by `ffmpeg` and encoded to Ogg/Opus; `GET /audio` serves that
  as a live HTTP stream (the first two Ogg pages — the Opus header/tags —
  are cached and replayed to every new listener first, since a stream
  decoder can't initialize without them).
- **Audio in**: a second virtual PulseAudio device (`virtmic`, a
  `module-pipe-source` backed by a named pipe) is the container's default
  microphone. `POST /audio/mic` accepts a live `MediaRecorder` (WebM/Opus)
  stream as a genuinely long-lived streaming request body, transcodes it
  with `ffmpeg`, and writes raw PCM straight into that pipe.

## Tech stack

Node.js 22 · Express · Xvfb · Fluxbox · ffmpeg · xdotool · PulseAudio · Google Chrome · Discord · xterm

## License

MIT — see [LICENSE](LICENSE).
