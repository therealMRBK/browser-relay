# desktop-relay: a full Linux desktop (Xvfb + Fluxbox + real Google Chrome)
# streamed to the client as MJPEG over plain HTTP and controlled via plain
# HTTP POSTs -- deliberately zero WebSockets anywhere, for a network that
# blocks the WS protocol outright. Chrome is launched as a normal desktop
# app (not via Playwright/CDP), so it is never automation-flagged: the
# Chrome Web Store, extensions, and everything else behaves exactly like a
# real user's browser, unlike a CDP-driven instance.
#
# Audio is bidirectional, both over plain HTTP (no WebSockets here either):
# PulseAudio (--system mode, see seedPulseSystemConfig in server.js) provides
# one virtual output sink ("chrome_out", Chrome's default audio device --
# its monitor is captured by ffmpeg and served as a live Ogg/Opus stream at
# GET /audio) and one virtual input source ("virtmic", a named-pipe source
# Chrome/Discord see as the default microphone -- POST /audio/mic streams a
# client's real mic, transcoded by ffmpeg, into that pipe).
#
# This is a full desktop, not just a Chrome kiosk -- Discord and a plain
# xterm are installed too, launched on demand via POST /apps/launch (see the
# launcher buttons in static/index.html), since there's no window manager
# taskbar/start-menu UI exposed through the relay to launch arbitrary apps
# any other way (Chrome fills the whole screen at all times, so there's no
# visible desktop background to right-click for Fluxbox's own root menu).
FROM node:22-bookworm

# intel-media-va-driver-non-free (VA-API driver for Iris Xe/Alder Lake+) lives
# in Debian's non-free component, not enabled by default in this base image.
# Patch the existing sources file rather than adding a new one -- this image
# uses the newer DEB822 format (debian.sources), and a duplicate classic
# sources.list entry for the same repo conflicts on Signed-By.
RUN if [ -f /etc/apt/sources.list.d/debian.sources ]; then \
      sed -i 's/^Components: main$/Components: main contrib non-free non-free-firmware/' /etc/apt/sources.list.d/debian.sources; \
    else \
      sed -i 's/^deb \(.*\) bookworm main$/deb \1 bookworm main contrib non-free non-free-firmware/' /etc/apt/sources.list; \
    fi

# zenity is here specifically for Discord (see the wget/install below), not
# for anything of our own: Discord's launcher (/usr/bin/discord) is a
# bootstrapper that downloads the real app on first run and invokes itself
# with `--zenity` to show a GTK progress dialog during that download --
# without zenity actually installed, this hangs indefinitely instead of
# failing or skipping the dialog (repro'd: the bootstrap process sat alive
# at ~0% CPU for minutes, never progressing, no error of any kind).
RUN apt-get update && apt-get install -y --no-install-recommends \
      xvfb \
      fluxbox \
      xdotool \
      xclip \
      ffmpeg \
      x11-utils \
      x11-xserver-utils \
      xcvt \
      dbus-x11 \
      pcmanfm \
      wget \
      gnupg \
      ca-certificates \
      fonts-liberation \
      mesa-va-drivers \
      libgl1-mesa-dri \
      intel-media-va-driver-non-free \
      vainfo \
      pulseaudio \
      pulseaudio-utils \
      locales \
      xterm \
      zenity \
    && wget -q -O /tmp/chrome.deb https://dl.google.com/linux/direct/google-chrome-stable_current_amd64.deb \
    && apt-get install -y --no-install-recommends /tmp/chrome.deb \
    && rm /tmp/chrome.deb \
    && wget -q -O /tmp/discord.deb "https://discord.com/api/download?platform=linux&format=deb" \
    && apt-get install -y --no-install-recommends /tmp/discord.deb \
    && rm /tmp/discord.deb \
    && rm -rf /var/lib/apt/lists/*

# No locale is configured at all by default in this base image (bare "C"),
# which breaks more than just display: xdotool's `type` command decodes its
# argument via the process locale, and under "C" it can't parse any
# multi-byte UTF-8 sequence at all -- typing anything outside plain ASCII
# (e.g. umlauts: ä/ö/ü) fails outright with "Invalid multi-byte sequence
# encountered", not just displays wrong. de_DE.UTF-8 fixes that AND gives
# Chrome (via LANG/LC_ALL/LANGUAGE in server.js's childEnv, plus --lang=de)
# a German UI by default.
RUN localedef -i de_DE -c -f UTF-8 -A /usr/share/locale/locale.alias de_DE.UTF-8

# fluxbox's default style references a background image via fbsetbg, which
# this minimal image's ImageMagick build can't actually apply (fails
# silently, but fbsetbg itself pops an xmessage error dialog on top of the
# desktop). xsetroot in the fluxbox init (server.js seedFluxboxInit) sets a
# plain color instead, but the style's own fbsetbg call fires independent of
# that -- neutralizing xmessage (used for nothing else here) is the
# reliable fix rather than chasing fluxbox's theming internals further.
RUN ln -sf /bin/true /usr/bin/xmessage

WORKDIR /app
COPY app/package.json ./
RUN npm install --omit=dev
COPY app/ .

ENV PORT=3000
ENV DATA_DIR=/data
ENV DISPLAY_WIDTH=1920
ENV DISPLAY_HEIGHT=1080
ENV TARGET_FPS=24
EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD wget -qO- http://127.0.0.1:3000/healthz || exit 1

CMD ["node", "server.js"]
