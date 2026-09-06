# desktop-relay: a full Linux desktop (Xvfb + Fluxbox + real Google Chrome)
# streamed to the client as MJPEG over plain HTTP and controlled via plain
# HTTP POSTs -- deliberately zero WebSockets anywhere, for a network that
# blocks the WS protocol outright. Chrome is launched as a normal desktop
# app (not via Playwright/CDP), so it is never automation-flagged: the
# Chrome Web Store, extensions, and everything else behaves exactly like a
# real user's browser, unlike a CDP-driven instance.
FROM node:22-bookworm

RUN apt-get update && apt-get install -y --no-install-recommends \
      xvfb \
      fluxbox \
      xdotool \
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
    && wget -q -O /tmp/chrome.deb https://dl.google.com/linux/direct/google-chrome-stable_current_amd64.deb \
    && apt-get install -y --no-install-recommends /tmp/chrome.deb \
    && rm /tmp/chrome.deb \
    && rm -rf /var/lib/apt/lists/*

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
