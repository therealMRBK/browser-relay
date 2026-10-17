/**
 * desktop-relay: a full Linux desktop (Xvfb + Fluxbox + a real, normally-
 * launched Google Chrome -- not driven via Playwright/CDP, so it is never
 * automation-flagged) streamed to the client as MJPEG over plain HTTP
 * (multipart/x-mixed-replace, produced by `ffmpeg -f x11grab`) and
 * controlled via plain HTTP POSTs (xdotool under the hood).
 *
 * No WebSocket anywhere, deliberately: built for a network that blocks the
 * WS protocol outright. Because Chrome is launched like any other desktop
 * app rather than through CDP, it looks and behaves exactly like a real
 * user's browser -- the Chrome Web Store, extensions, and cookies/logins
 * all just work, with no automation-detection cat-and-mouse.
 */
const path = require("path");
const fsp = require("fs/promises");
const fssync = require("fs");
const { spawn, execFile } = require("child_process");
const express = require("express");
const multer = require("multer");

const PORT = process.env.PORT || 3000;
const DATA_DIR = process.env.DATA_DIR || "/data";
const PROFILE_DIR = path.join(DATA_DIR, "chrome-profile");
const SHARED_DIR = path.join(DATA_DIR, "shared");
const UPLOAD_TMP_DIR = "/tmp/desktop-relay-uploads";

// Mutable: /resize changes these at runtime (real xrandr resolution
// switching, not just a client-side CSS scale) -- see resizeDisplay().
let DISPLAY_WIDTH = parseInt(process.env.DISPLAY_WIDTH || "1600", 10);
let DISPLAY_HEIGHT = parseInt(process.env.DISPLAY_HEIGHT || "900", 10);
const TARGET_FPS = parseInt(process.env.TARGET_FPS || "12", 10);
const DISPLAY = ":99";
const MJPEG_BOUNDARY = "frame";
const PULSE_SOCKET = "/var/run/pulse/native";
// Deliberately NOT under /tmp: it's world-writable with the sticky bit set,
// and the kernel's fs.protected_fifos hardening (on by default on modern
// Debian) refuses to open a FIFO there when its owner doesn't match the
// opening process's uid -- even for root. PulseAudio's pipe-source module
// creates and owns this FIFO as the "pulse" system user, so ffmpeg (running
// as root) got a flat "Permission denied" trying to open it under /tmp.
// A root-owned, non-world-writable directory sidesteps the restriction
// entirely (it only applies to world-writable/sticky directories).
const MIC_FIFO_DIR = "/run/desktop-relay";
const MIC_FIFO_PATH = path.join(MIC_FIFO_DIR, "virtmic");

const childEnv = {
  ...process.env,
  DISPLAY,
  PULSE_SERVER: `unix:${PULSE_SOCKET}`,
  // de_DE.UTF-8 fixes two unrelated things at once (see the Dockerfile's
  // localedef comment): xdotool's `type` can't decode multi-byte UTF-8
  // (umlauts, accents) at all under the default "C" locale, and this also
  // gives Chrome a German UI by default (--lang=de below is the more
  // direct/reliable way to set that, but LANG/LANGUAGE are still needed for
  // xdotool and anything else that reads locale env vars).
  LANG: "de_DE.UTF-8",
  LC_ALL: "de_DE.UTF-8",
  LANGUAGE: "de_DE:de",
};

function xdotool(args) {
  return new Promise((resolve, reject) => {
    execFile("xdotool", args, { env: childEnv }, (err) => (err ? reject(err) : resolve()));
  });
}

function execFilePromise(cmd, args) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { env: childEnv }, (err, stdout) => (err ? reject(err) : resolve(stdout)));
  });
}

async function waitForX11Socket(timeoutMs = 15000) {
  const socketPath = `/tmp/.X11-unix/X99`;
  const start = Date.now();
  while (!fssync.existsSync(socketPath)) {
    if (Date.now() - start > timeoutMs) throw new Error("Xvfb did not start in time");
    await new Promise((r) => setTimeout(r, 200));
  }
  // The socket file can exist slightly before Xvfb accepts connections.
  await new Promise((r) => setTimeout(r, 300));
}

async function waitForPulseSocket(timeoutMs = 15000) {
  const start = Date.now();
  while (!fssync.existsSync(PULSE_SOCKET)) {
    if (Date.now() - start > timeoutMs) throw new Error("PulseAudio did not start in time");
    await new Promise((r) => setTimeout(r, 200));
  }
  await new Promise((r) => setTimeout(r, 300));
}

// Keeps a process running: restarts it whenever it exits. A process that keeps dying right away (something it needs is missing or
// broken) is retried less and less often - 2 s, 4 s, 8 s ... up to 60 s - instead of every 2 s for ever: on 2026-10-02 a stale Xvfb
// lock made Xvfb, fluxbox and Chrome fail every 2 s for four days, and every failed Chrome start left a 4 MB BrowserMetrics file in
// the profile until the host's disk was full. One that ran for a minute or more starts over at 2 s. `before` (sync) runs before
// every start - the place to clear whatever a dead instance left behind.
function spawnPersistent(name, command, args, before = null, delay = 1000) {
  if (before) { try { before(); } catch (e) { console.error(`${name}: clean-up before start failed: ${e.message}`); } }
  const started = Date.now();
  const proc = spawn(command, args, { env: childEnv, stdio: ["ignore", "pipe", "pipe"] });
  proc.on("exit", (code, signal) => {
    const ran = Date.now() - started, next = ran >= 60000 ? 2000 : Math.min(60000, delay * 2);
    console.error(`${name} exited (code=${code}, signal=${signal}) after ${Math.round(ran / 1000)}s -- restarting in ${next / 1000}s`);
    setTimeout(() => spawnPersistent(name, command, args, before, next), next);
  });
  proc.stderr.on("data", (d) => process.stderr.write(`[${name}] ${d}`));
  return proc;
}

// Xvfb's lock (/tmp/.X99-lock, holding its PID) and socket outlive Xvfb itself when the container is stopped or the host goes down,
// and /tmp is not cleared when the same container starts again. After the host reboot of 2026-10-02 the lock named PID 20 - by
// then a different process - so every new Xvfb said "Server is already active for display 99" and quit, for days. Only this
// server ever runs an Xvfb here, and it only starts one after the last one exited: whatever lock is there is stale.
function clearStaleXvfbLock() {
  for (const f of ["/tmp/.X99-lock", "/tmp/.X11-unix/X99"]) fssync.rmSync(f, { force: true });
}

// Chrome leaves a BrowserMetrics-*.pma file (about 4 MB of usage statistics, nothing else) for every start it does not shut down
// cleanly. They piled up to 37 GB. Chrome is not running when this runs (before each start), so all of them can go.
function clearChromeMetrics() {
  const dir = path.join(PROFILE_DIR, "BrowserMetrics");
  if (!fssync.existsSync(dir)) return;
  for (const f of fssync.readdirSync(dir)) if (f.endsWith(".pma")) fssync.rmSync(path.join(dir, f), { force: true });
}
function clearStaleChromeLockSync() {
  for (const name of ["SingletonLock", "SingletonSocket", "SingletonCookie"]) fssync.rmSync(path.join(PROFILE_DIR, name), { force: true });
}

// Chrome writes SingletonLock/-Socket/-Cookie into the profile dir to stop
// two instances from sharing (and corrupting) one profile at once, keyed by
// hostname+PID. That protection is meaningless here -- this container's
// whole job is running exactly one Chrome against this profile at a time --
// but the check itself doesn't know that: PROFILE_DIR lives on a volume that
// outlives any single container, and every fresh container gets a new
// random hostname (Docker's default), so Chrome sees "different computer,
// lock still held" and refuses to start with a profile-in-use dialog on any
// container *recreate* (not a plain restart of the same container, which
// keeps the same hostname and lets Chrome's own graceful-shutdown handling
// clean this up itself). Confirmed by reproducing it after a rebuild+
// recreate cycle. Deleting these unconditionally before every launch is
// safe precisely because there is never a second real instance to protect
// against.
async function clearStaleChromeLock() {
  for (const name of ["SingletonLock", "SingletonSocket", "SingletonCookie"]) {
    await fsp.rm(path.join(PROFILE_DIR, name), { force: true }).catch(() => {});
  }
}

// Chrome has no CLI flag for "default download directory" -- it's a
// profile preference. Seeding it before first launch means downloads land
// in SHARED_DIR without a save-dialog prompt, no CDP involved.
async function seedChromePreferences() {
  const defaultProfileDir = path.join(PROFILE_DIR, "Default");
  const prefsPath = path.join(defaultProfileDir, "Preferences");
  if (fssync.existsSync(prefsPath)) return;
  await fsp.mkdir(defaultProfileDir, { recursive: true });
  const prefs = {
    download: { default_directory: SHARED_DIR, prompt_for_download: false, directory_upgrade: true },
    profile: { default_content_setting_values: { notifications: 2 } },
    browser: { check_default_browser: false },
  };
  await fsp.writeFile(prefsPath, JSON.stringify(prefs));
}

let ffmpegProc = null;
let lastFrame = null;
let lastFrameSeq = 0; // bumped on every new frame; lets a client loop notice new work without polling a timer

// Pull-based delivery, not push-based: each client runs its own loop that,
// the instant it finishes flushing one frame to the OS, immediately looks
// up whatever `lastFrame` is *right now* and sends that -- never a queued
// backlog of intermediate frames. If ffmpeg produces frames faster than a
// client can consume them, the frames produced in between are simply never
// sent to that client (dropped), same as how a live UDP stream behaves
// with no retransmission/buffering. This replaces an earlier design that
// pushed every frame reactively and skipped writes only when already
// backed up (`res.writableNeedDrain`) -- structurally similar in intent,
// but reactive-push still allows one frame to queue up per production tick
// during the round-trip before the flag reflects reality, and does nothing
// to bound *ffmpeg's own* internal encode latency if the host is CPU/memory
// constrained. Pull-based delivery at least guarantees this relay is never
// the thing adding backlog beyond a single in-flight frame per client.
function streamToClient(res) {
  let closed = false;
  res.on("close", () => {
    closed = true;
  });

  function sendNext() {
    if (closed) return;
    if (!lastFrame) {
      setTimeout(sendNext, 50);
      return;
    }
    const seqAtSend = lastFrameSeq;
    const frame = lastFrame;
    res.write(`--${MJPEG_BOUNDARY}\r\nContent-type: image/jpeg\r\nContent-length: ${frame.length}\r\n\r\n`);
    res.write(frame);
    res.write("\r\n", (err) => {
      if (err || closed) return;
      if (lastFrameSeq === seqAtSend) {
        // No new frame arrived while we were sending -- avoid a hot busy
        // loop re-sending the identical frame; check back shortly instead.
        setTimeout(sendNext, 1000 / TARGET_FPS);
      } else {
        sendNext();
      }
    });
  }
  sendNext();
}

// ffmpeg's own mpjpeg output is relayed raw by neither this nor the old
// browser-relay approach -- both re-frame every part themselves (via
// streamToClient above) rather than blindly forwarding ffmpeg's byte
// stream. That matters here specifically because a client connecting
// mid-stream would otherwise start receiving from an arbitrary byte offset
// (not a frame boundary) with no priming at all, which some browsers/
// proxies never recover from -- looks like a stream that "just loads
// forever". Parsing ffmpeg's Content-length-delimited parts out of its
// stdout into `lastFrame` and letting each client's own pull loop pick it up
// (see streamToClient) guarantees every client always starts from -- and
// stays on -- a valid, complete frame, never a partial one.
let ffmpegBuffer = Buffer.alloc(0);
const HEADER_RE = /Content-type: image\/jpeg\r\nContent-length: (\d+)\r\n\r\n/i;

function parseFfmpegChunk(chunk) {
  ffmpegBuffer = ffmpegBuffer.length ? Buffer.concat([ffmpegBuffer, chunk]) : chunk;
  for (;;) {
    const match = HEADER_RE.exec(ffmpegBuffer.toString("latin1"));
    if (!match || match.index === undefined) return;
    const headerEnd = match.index + match[0].length;
    const jpegLen = parseInt(match[1], 10);
    if (ffmpegBuffer.length < headerEnd + jpegLen) return; // wait for more data
    const jpegBuf = ffmpegBuffer.subarray(headerEnd, headerEnd + jpegLen);
    lastFrame = Buffer.from(jpegBuf);
    lastFrameSeq++;
    ffmpegBuffer = ffmpegBuffer.subarray(headerEnd + jpegLen);
  }
}

// Set true immediately before deliberately killing ffmpeg (e.g. for a
// resize, which needs a new -video_size) so its exit handler restarts it
// right away instead of treating the exit as a crash and waiting 1s.
let ffmpegRestartExpected = false;

function startFfmpegCapture() {
  // Reads DISPLAY_WIDTH/HEIGHT fresh at call time (not closed over at
  // startup), so a restart after resizeDisplay() updates them picks up the
  // new resolution automatically.
  const args = [
    "-loglevel",
    "error",
    "-f",
    "x11grab",
    "-video_size",
    `${DISPLAY_WIDTH}x${DISPLAY_HEIGHT}`,
    "-framerate",
    String(TARGET_FPS),
    "-i",
    DISPLAY,
    "-f",
    "mpjpeg",
    "-boundary_tag",
    MJPEG_BOUNDARY,
    "-q:v",
    "5",
    "pipe:1",
  ];
  const proc = spawn("ffmpeg", args, { env: childEnv, stdio: ["ignore", "pipe", "pipe"] });
  proc.stdout.on("data", parseFfmpegChunk);
  proc.stderr.on("data", (d) => process.stderr.write(`[ffmpeg] ${d}`));
  proc.on("exit", (code, signal) => {
    ffmpegBuffer = Buffer.alloc(0);
    if (ffmpegRestartExpected) {
      ffmpegRestartExpected = false;
      startFfmpegCapture();
    } else {
      console.error(`ffmpeg exited (code=${code}, signal=${signal}) -- restarting in 1s`);
      setTimeout(startFfmpegCapture, 1000);
    }
  });
  ffmpegProc = proc;
}

function restartFfmpegCapture() {
  if (!ffmpegProc) {
    startFfmpegCapture();
    return;
  }
  ffmpegRestartExpected = true;
  ffmpegProc.kill("SIGTERM");
}

// --- Audio out: Chrome's audio (default sink "chrome_out", see
// seedPulseSystemConfig) captured live and served as Ogg/Opus over plain
// HTTP -- GET /audio. Same principle as the video relay above (never
// blindly forward a source byte stream to a client with no priming), but
// the reframing unit here is an Ogg *page*, not an MJPEG part: any client
// that starts receiving mid-stream without first getting the initial pages
// (OpusHead + OpusTags) can't initialize its decoder at all, so those first
// pages are cached and replayed to every new client before it joins the
// live broadcast. Push-based broadcast (not the video relay's pull-based
// per-client loop) is the right tradeoff here -- some client-side audio
// buffering is normal/expected for a "listen along" stream, unlike the
// video path's deliberate low-latency/no-backlog requirement for mouse
// control responsiveness. ---

const OGG_HEADER_PAGE_COUNT = 2; // OpusHead + OpusTags, always exactly 2 for a fresh Opus stream
let oggHeaderPages = []; // cached raw bytes of the first 2 pages, replayed to every new listener
let oggBuffer = Buffer.alloc(0);
const audioListeners = new Set(); // Set<express.Response>
// A listener connecting in the brief window before ffmpeg has produced its
// first 2 pages yet would otherwise get an empty header replay and never
// receive one at all (the live-broadcast branch below never sends header
// pages to `audioListeners`) -- park them here instead, flushed the instant
// headers complete.
const pendingAudioListeners = new Set();
let audioFfmpegProc = null;

function parseOggPages(chunk, onPage) {
  oggBuffer = oggBuffer.length ? Buffer.concat([oggBuffer, chunk]) : chunk;
  for (;;) {
    if (oggBuffer.length < 27) return; // minimum fixed Ogg page header size
    if (oggBuffer.toString("latin1", 0, 4) !== "OggS") {
      // Should never happen with a well-formed ffmpeg ogg stream -- resync
      // by scanning forward rather than getting stuck if it ever does.
      const nextMagic = oggBuffer.indexOf("OggS", 1, "latin1");
      if (nextMagic === -1) {
        oggBuffer = Buffer.alloc(0);
        return;
      }
      oggBuffer = oggBuffer.subarray(nextMagic);
      continue;
    }
    const segmentCount = oggBuffer[26];
    const headerLen = 27 + segmentCount;
    if (oggBuffer.length < headerLen) return; // wait for the segment table itself
    let payloadLen = 0;
    for (let i = 0; i < segmentCount; i++) payloadLen += oggBuffer[27 + i];
    const pageLen = headerLen + payloadLen;
    if (oggBuffer.length < pageLen) return; // wait for the full payload
    onPage(Buffer.from(oggBuffer.subarray(0, pageLen)));
    oggBuffer = oggBuffer.subarray(pageLen);
  }
}

function broadcastOggPage(page) {
  if (oggHeaderPages.length < OGG_HEADER_PAGE_COUNT) {
    oggHeaderPages.push(page);
    if (oggHeaderPages.length === OGG_HEADER_PAGE_COUNT) {
      for (const res of pendingAudioListeners) {
        for (const headerPage of oggHeaderPages) res.write(headerPage);
        audioListeners.add(res);
      }
      pendingAudioListeners.clear();
    }
    return; // header pages are sent to listeners as they join, not live-broadcast
  }
  for (const res of audioListeners) res.write(page);
}

function startAudioCapture() {
  const args = [
    "-loglevel", "error",
    "-f", "pulse",
    "-i", "chrome_out.monitor",
    "-ac", "2",
    "-ar", "48000",
    "-c:a", "libopus",
    "-b:a", "96k",
    "-f", "ogg",
    "pipe:1",
  ];
  const proc = spawn("ffmpeg", args, { env: childEnv, stdio: ["ignore", "pipe", "pipe"] });
  proc.stdout.on("data", (chunk) => parseOggPages(chunk, broadcastOggPage));
  proc.stderr.on("data", (d) => process.stderr.write(`[audio-ffmpeg] ${d}`));
  proc.on("exit", (code, signal) => {
    oggBuffer = Buffer.alloc(0);
    oggHeaderPages = [];
    console.error(`audio ffmpeg exited (code=${code}, signal=${signal}) -- restarting in 1s`);
    setTimeout(startAudioCapture, 1000);
  });
  audioFfmpegProc = proc;
}

// --- Audio in: a client's real microphone, streamed here and transcoded
// into the "virtmic" named-pipe source (see seedPulseSystemConfig) so
// Chrome/Discord inside the container see it as their default microphone.
// The client streams a live MediaRecorder(audio/webm;codecs=opus) session as
// the POST body (a genuinely long-lived streaming request, not repeated
// small POSTs -- webm chunks after the first aren't independently
// decodable, they need the original stream's header) straight into ffmpeg's
// stdin; ffmpeg writes raw PCM directly to the pipe path. Only one mic
// session makes sense at a time (there's exactly one virtual microphone) --
// a new POST simply takes over from whatever was streaming before. ---

let micFfmpegProc = null;

function stopMicCapture() {
  if (micFfmpegProc) {
    micFfmpegProc.kill("SIGTERM");
    micFfmpegProc = null;
  }
}

// Real xrandr resolution switching (not a client-side CSS scale) so the
// remote desktop's actual pixels match the viewer's window -- crisp text,
// no letterboxing. `cvt` computes a valid modeline for the target size;
// ffmpeg can't resize its capture without restarting, so that follows; the
// browser window itself is resized/repositioned to fill the new screen.
let randrOutputName = null;

async function getRandrOutputName() {
  if (randrOutputName) return randrOutputName;
  const out = await execFilePromise("xrandr", []);
  const connected = out.split("\n").find((l) => / connected/.test(l));
  randrOutputName = connected ? connected.split(" ")[0] : "screen";
  return randrOutputName;
}

async function resizeDisplay(width, height) {
  const output = await getRandrOutputName();
  const cvtOut = await execFilePromise("cvt", [String(width), String(height)]);
  const modeline = /Modeline\s+"[^"]+"\s+(.+)/.exec(cvtOut);
  if (!modeline) throw new Error("cvt produced no modeline");
  const modeParams = modeline[1].trim().split(/\s+/);
  const modeName = `custom_${width}x${height}`;

  await execFilePromise("xrandr", ["--newmode", modeName, ...modeParams]).catch(() => {});
  await execFilePromise("xrandr", ["--addmode", output, modeName]).catch(() => {});
  await execFilePromise("xrandr", ["--output", output, "--mode", modeName]);

  DISPLAY_WIDTH = width;
  DISPLAY_HEIGHT = height;
  restartFfmpegCapture();

  await xdotool(["getactivewindow", "windowsize", String(width), String(height)]).catch(() => {});
  await xdotool(["getactivewindow", "windowmove", "0", "0"]).catch(() => {});
}

// Fluxbox's own default init config runs `fbsetbg` (an ImageMagick-backed
// wallpaper setter) on startup, which pops an error dialog on failure --
// this minimal image's ImageMagick build doesn't support the X11 root-
// window write fbsetbg needs. A plain solid color via xsetroot needs no
// such dependency, so override fluxbox's rootCommand before its first
// launch (its config dir is not on the persistent volume -- regenerated
// fresh every container start, so this must run every time, not just once).
async function seedFluxboxInit() {
  const fluxboxDir = path.join(process.env.HOME || "/root", ".fluxbox");
  await fsp.mkdir(fluxboxDir, { recursive: true });
  const initPath = path.join(fluxboxDir, "init");
  const existing = fssync.existsSync(initPath) ? await fsp.readFile(initPath, "utf8") : "";
  const withoutRootCommand = existing
    .split("\n")
    .filter((line) => !line.startsWith("session.screen0.rootCommand:"))
    .join("\n");
  await fsp.writeFile(initPath, `${withoutRootCommand}\nsession.screen0.rootCommand: xsetroot -solid "#2b2b2b"\n`);
}

// Fluxbox draws its own title bar above every window by default. With
// Chrome positioned at (0,0) filling the whole Xvfb screen, that decoration
// has nowhere to go but off the top edge of the screen -- it's the "cut off
// head" at the top of the captured video. Same treatment for Discord, since
// it's launched full-screen the same way (see /apps/launch) -- an xterm
// launched via the same route deliberately keeps its title bar/border,
// since it's meant to be a small movable/resizable window alongside
// whatever else is open, not a fullscreen app. Same as seedFluxboxInit,
// this file isn't on the persistent volume and must be rewritten every
// container start.
async function seedFluxboxApps() {
  const fluxboxDir = path.join(process.env.HOME || "/root", ".fluxbox");
  await fsp.mkdir(fluxboxDir, { recursive: true });
  const appsPath = path.join(fluxboxDir, "apps");
  await fsp.writeFile(
    appsPath,
    // WM_CLASS is case-sensitive here and NOT what the binary/package name
    // would suggest -- confirmed via `xprop WM_CLASS` against a real running
    // window: Discord's is "Discord" (capital), not "discord".
    "[app] (class=Google-chrome)\n [Deco]\t{NONE}\n[end]\n" + "[app] (class=Discord)\n [Deco]\t{NONE}\n[end]\n"
  );
}

// PulseAudio in --system mode (not a per-user session daemon) since
// everything in this container runs as root and there's no multi-user
// desktop to isolate -- system mode is the one PulseAudio explicitly
// supports running as root. Two virtual devices, no real sound hardware
// needed at all: "chrome_out" is a null-sink Chrome's audio defaults to
// (its .monitor is what ffmpeg captures for GET /audio), and "virtmic" is a
// module-pipe-source backed by a named pipe at MIC_FIFO_PATH -- anything
// written there (see the /audio/mic route's ffmpeg transcoder) shows up as
// live microphone input. Both are set as defaults so Chrome/Discord pick
// them up with no manual device selection. system.pa isn't on the
// persistent volume, so, like the fluxbox config, this must be (re)written
// every container start, not just once.
async function seedPulseSystemConfig() {
  const systemPaPath = "/etc/pulse/system.pa";
  const config = [
    "#!/usr/bin/pulseaudio -nF",
    "load-module module-native-protocol-unix auth-anonymous=1",
    "load-module module-null-sink sink_name=chrome_out sink_properties=device.description=ChromeOutput",
    "set-default-sink chrome_out",
    `load-module module-pipe-source source_name=virtmic file=${MIC_FIFO_PATH} format=s16le rate=48000 channels=2 source_properties=device.description=VirtualMicrophone`,
    "set-default-source virtmic",
    "",
  ].join("\n");
  await fsp.mkdir(path.dirname(systemPaPath), { recursive: true });
  await fsp.writeFile(systemPaPath, config);
  await fsp.mkdir(path.dirname(PULSE_SOCKET), { recursive: true }).catch(() => {});
  // PulseAudio's module-pipe-source runs as the "pulse" system user (not
  // root) and mkfifo()s this path itself -- needs the directory writable by
  // that user, but NOT the sticky bit (0o755 caused a plain mkfifo
  // "Permission denied" from pulseaudio itself; adding the sticky bit
  // instead of avoiding it would just reintroduce the fs.protected_fifos
  // issue this directory exists to sidestep in the first place). mkdir's
  // own `mode` option is masked by the process umask, so chmod explicitly
  // afterward to guarantee 0o777 regardless of umask.
  await fsp.mkdir(MIC_FIFO_DIR, { recursive: true });
  await fsp.chmod(MIC_FIFO_DIR, 0o777);
}

async function initDesktop() {
  await fsp.mkdir(PROFILE_DIR, { recursive: true });
  await fsp.mkdir(SHARED_DIR, { recursive: true });
  await fsp.mkdir(UPLOAD_TMP_DIR, { recursive: true });
  await clearStaleChromeLock();
  await seedChromePreferences();

  await seedPulseSystemConfig();
  spawnPersistent("pulseaudio", "pulseaudio", ["--system", "--disallow-exit", "--exit-idle-time=-1"]);
  await waitForPulseSocket();

  spawnPersistent("Xvfb", "Xvfb", [DISPLAY, "-screen", "0", `${DISPLAY_WIDTH}x${DISPLAY_HEIGHT}x24`, "-nolisten", "tcp", "-ac"], clearStaleXvfbLock);
  await waitForX11Socket();

  await seedFluxboxInit();
  await seedFluxboxApps();
  spawnPersistent("fluxbox", "fluxbox", []);
  await new Promise((r) => setTimeout(r, 1000));

  // No --enable-automation, no CDP, no remote-debugging-port -- a normal
  // Chrome launch, indistinguishable from a real user's browser.
  //
  // GPU flags below hand rendering to the passed-through iGPU (/dev/dri)
  // instead of Chrome's software rasterizer (SwiftShader) -- Xvfb has no
  // GPU of its own, so Chrome must be told explicitly to use the real
  // device via EGL/Mesa rather than falling back to software. This only
  // affects how Chrome renders internally; ffmpeg's x11grab capture of the
  // resulting X11 framebuffer, and the MJPEG streaming pipeline, are
  // unaffected either way.
  spawnPersistent("chrome", "google-chrome", [
    `--user-data-dir=${PROFILE_DIR}`,
    "--no-sandbox", // required running as root in a container; unrelated to automation flagging
    "--no-first-run",
    "--no-default-browser-check",
    "--password-store=basic",
    "--lang=de",
    "--window-position=0,0",
    `--window-size=${DISPLAY_WIDTH},${DISPLAY_HEIGHT}`,
    "--ignore-gpu-blocklist",
    "--disable-gpu-sandbox",
    "--use-gl=angle",
    "--use-angle=gl",
    "--enable-gpu-rasterization",
    "--enable-zero-copy",
    "--enable-native-gpu-memory-buffers",
    "--enable-features=VaapiVideoDecoder,VaapiVideoEncoder",
    "about:blank",
  ], () => { clearStaleChromeLockSync(); clearChromeMetrics(); });

  startFfmpegCapture();
  startAudioCapture();
}

const app = express();
app.use((req, res, next) => (req.path === "/clipboard" ? next() : express.json()(req, res, next)));
const upload = multer({ dest: UPLOAD_TMP_DIR });

app.get("/", (req, res) => {
  res.sendFile(__dirname + "/static/index.html");
});
app.use("/static", express.static(__dirname + "/static"));

app.get("/info", (req, res) => {
  res.json({ width: DISPLAY_WIDTH, height: DISPLAY_HEIGHT, fps: TARGET_FPS });
});

app.post("/resize", async (req, res) => {
  const width = Math.max(320, Math.min(3840, parseInt(req.body?.width, 10) || DISPLAY_WIDTH));
  const height = Math.max(240, Math.min(2160, parseInt(req.body?.height, 10) || DISPLAY_HEIGHT));
  if (width === DISPLAY_WIDTH && height === DISPLAY_HEIGHT) {
    return res.json({ ok: true, width, height, changed: false });
  }
  try {
    await resizeDisplay(width, height);
    res.json({ ok: true, width, height, changed: true });
  } catch (e) {
    res.status(500).json({ error: e instanceof Error ? e.message : String(e) });
  }
});

app.get("/stream", (req, res) => {
  res.writeHead(200, {
    "Content-Type": `multipart/x-mixed-replace; boundary=${MJPEG_BOUNDARY}`,
    "Cache-Control": "no-cache, no-store, must-revalidate",
    Pragma: "no-cache",
  });
  streamToClient(res);
});

// Live audio out (Chrome's sound) -- see the "Audio out" block above for the
// header-priming rationale. Every new listener gets the cached OpusHead/
// OpusTags pages first, then joins the live broadcast set.
app.get("/audio", (req, res) => {
  res.writeHead(200, {
    "Content-Type": "audio/ogg",
    "Cache-Control": "no-cache, no-store, must-revalidate",
    Pragma: "no-cache",
  });
  if (oggHeaderPages.length === OGG_HEADER_PAGE_COUNT) {
    for (const page of oggHeaderPages) res.write(page);
    audioListeners.add(res);
  } else {
    pendingAudioListeners.add(res); // flushed by broadcastOggPage once headers complete
  }
  req.on("close", () => {
    audioListeners.delete(res);
    pendingAudioListeners.delete(res);
  });
});

// Microphone in -- see the "Audio in" block above. Deliberately NOT behind
// express.json() (that middleware only touches application/json bodies by
// default, so this raw audio/webm body passes through untouched). The
// request stays open for as long as the client keeps streaming; ffmpeg's
// stdin ends (and the transcoder exits) when the client stops.
app.post("/audio/mic", (req, res) => {
  stopMicCapture();
  const proc = spawn(
    "ffmpeg",
    ["-y", "-loglevel", "error", "-f", "webm", "-i", "pipe:0", "-ac", "2", "-ar", "48000", "-f", "s16le", MIC_FIFO_PATH],
    { env: childEnv, stdio: ["pipe", "ignore", "pipe"] }
  );
  proc.stderr.on("data", (d) => process.stderr.write(`[mic-ffmpeg] ${d}`));
  micFfmpegProc = proc;
  // `.pipe()` ends proc.stdin (EOF) once req finishes -- that alone is
  // enough for ffmpeg to flush whatever it's still decoding and exit on its
  // own; don't SIGTERM it right when the request body ends, that killed it
  // mid-flush and dropped nearly everything still buffered (caught via a
  // real test: a throttled-but-finite upload only ever produced ~29 bytes
  // of PCM out of an expected ~500KB+ until this was fixed).
  req.pipe(proc.stdin);
  req.on("close", () => {
    if (!res.headersSent) res.json({ ok: true });
  });
  proc.on("exit", () => {
    if (micFfmpegProc === proc) micFfmpegProc = null;
  });
});

// On-demand app launching -- see the Dockerfile's header comment for why
// this exists at all (no reachable taskbar/root-menu UI to launch arbitrary
// apps otherwise, since Chrome fills the whole screen). Not tracked/
// singleton server-side: Discord enforces single-instance itself, and
// multiple terminals is a completely normal thing to want.
// Discord is Electron-based, same as Chrome, and has the identical hard
// requirement: it refuses outright to run as root without --no-sandbox
// ("Running as root without --no-sandbox is not supported", a FATAL crash,
// not a warning) -- unrelated to any container-specific sandboxing, this is
// Electron's own root check.
//
// Discord's launcher script is a bootstrapper, not the app itself -- first
// run downloads the real app from Discord's update servers into
// $HOME/.config/discord (confirmed: "Install Complete / Bootstrap complete"
// on first launch, ~20s+ depending on network, before the actual Electron
// process even starts). Tried pointing that at a directory under DATA_DIR
// instead, to persist it across container recreates like the Chrome
// profile -- caused Discord to hang forever on its own splash screen on the
// next launch after a recreate (repro'd twice; likely some cached
// machine/session identity mismatch the updater doesn't handle gracefully).
// Not worth chasing further: the plain default is completely reliable, just
// pays the ~20s bootstrap cost once per container lifetime (not once per
// launch -- it's cached in that container's $HOME for as long as it stays
// running, only a full recreate loses it) rather than never.
const LAUNCHABLE_APPS = {
  discord: { command: "discord", args: ["--no-sandbox"], env: {} },
  terminal: { command: "xterm", args: [], env: {} },
};

app.post("/apps/launch", (req, res) => {
  const app_ = LAUNCHABLE_APPS[req.body?.app];
  if (!app_) return res.status(400).json({ error: "unknown app" });

  const proc = spawn(app_.command, app_.args, { env: { ...childEnv, ...app_.env }, stdio: "ignore", detached: true });
  proc.unref();
  proc.on("error", (e) => console.error(`[launch:${req.body.app}] failed to start: ${e.message}`));

  if (req.body.app === "discord") {
    // Discord (Electron) doesn't take Chrome-style --window-position/
    // --window-size flags, so it doesn't start filling the screen the way
    // Chrome does -- size/move it the same way a manual resize would
    // (resizeDisplay), just targeted by window class instead of "whatever's
    // currently focused" since it isn't focused yet right after spawning.
    // Polls rather than a single fixed delay: first-ever launch (the
    // bootstrap download above) can take 20s+, but once cached on the
    // volume, the real window usually appears within 1-2s -- a single
    // timeout can't fit both without either being needlessly slow every
    // time or missing the window entirely on a cold first run.
    const deadline = Date.now() + 45000;
    const tryResize = async () => {
      try {
        // --onlyvisible: Discord's WM_CLASS is shared by more than just the
        // main window (helper/overlay windows match too) -- resizing the
        // wrong one silently leaves the actually-visible window untouched.
        const out = await execFilePromise("xdotool", ["search", "--onlyvisible", "--class", "Discord"]);
        const ids = out.trim().split("\n").filter(Boolean);
        if (ids.length > 0) {
          for (const id of ids) {
            await xdotool(["windowsize", id, String(DISPLAY_WIDTH), String(DISPLAY_HEIGHT)]);
            await xdotool(["windowmove", id, "0", "0"]);
          }
          await xdotool(["windowactivate", ids[ids.length - 1]]);
          return;
        }
      } catch {
        // no window yet -- expected while discord is still bootstrapping/starting
      }
      if (Date.now() < deadline) setTimeout(tryResize, 2000);
    };
    setTimeout(tryResize, 2000);
  }

  res.json({ ok: true });
});

const NAMED_KEY_TO_XDOTOOL = {
  Enter: "Return",
  Backspace: "BackSpace",
  Tab: "Tab",
  Escape: "Escape",
  Delete: "Delete",
  Home: "Home",
  End: "End",
  PageUp: "Prior",
  PageDown: "Next",
  ArrowUp: "Up",
  ArrowDown: "Down",
  ArrowLeft: "Left",
  ArrowRight: "Right",
  Insert: "Insert",
  F1: "F1",
  F2: "F2",
  F3: "F3",
  F4: "F4",
  F5: "F5",
  F6: "F6",
  F7: "F7",
  F8: "F8",
  F9: "F9",
  F10: "F10",
  F11: "F11",
  F12: "F12",
};
const MODIFIER_TO_XDOTOOL = { Control: "ctrl", Meta: "super", Alt: "alt", Shift: "shift" };

app.post("/input/mouse", async (req, res) => {
  const { type, x, y, button, deltaX, deltaY } = req.body || {};
  try {
    // No --sync on mousemove: it makes xdotool block until the X server
    // confirms the pointer actually moved, which adds a round-trip that
    // gets worse under load (ffmpeg is also hammering the same X server for
    // capture) -- unnecessary since nothing here depends on the move having
    // visibly completed before responding.
    if (type === "move") {
      await xdotool(["mousemove", String(x), String(y)]);
    } else if (type === "down") {
      await xdotool(["mousemove", String(x), String(y)]);
      await xdotool(["mousedown", button === "right" ? "3" : button === "middle" ? "2" : "1"]);
    } else if (type === "up") {
      await xdotool(["mouseup", button === "right" ? "3" : button === "middle" ? "2" : "1"]);
    } else if (type === "wheel") {
      const clicks = Math.min(10, Math.max(1, Math.round(Math.abs(deltaY || 0) / 50)));
      await xdotool(["click", "--repeat", String(clicks), deltaY > 0 ? "5" : "4"]);
    }
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e instanceof Error ? e.message : String(e) });
  }
});

app.post("/input/key", async (req, res) => {
  const { action, key, text } = req.body || {};
  try {
    if (action === "type") {
      await xdotool(["type", "--", text]);
    } else if (action === "press") {
      // "Control+Shift+T"-style combo strings (see static/index.html) split
      // into xdotool's lowercase-modifier "ctrl+shift+t" syntax. Critically,
      // a bare letter must be lowercased unless "Shift" is explicitly one of
      // the parts: X11 keysym "A" *is* shift+a, so "ctrl+A" from xdotool's
      // perspective means Ctrl+Shift+a, not plain Ctrl+A -- the client
      // already adds an explicit "Shift" part when it means to shift.
      const parts = key.split("+");
      const xdoParts = parts.map((p) => {
        if (MODIFIER_TO_XDOTOOL[p]) return MODIFIER_TO_XDOTOOL[p];
        if (NAMED_KEY_TO_XDOTOOL[p]) return NAMED_KEY_TO_XDOTOOL[p];
        return p.length === 1 ? p.toLowerCase() : p;
      });
      await xdotool(["key", xdoParts.join("+")]);
    }
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e instanceof Error ? e.message : String(e) });
  }
});

// --- Shared folder: the one universal answer to both upload and download
// for a full desktop (no per-app hook like Playwright's filechooser exists
// generically across arbitrary native dialogs) -- point any file dialog at
// this folder, and downloads land here automatically (see
// seedChromePreferences). ---

app.get("/files", async (req, res) => {
  const entries = await fsp.readdir(SHARED_DIR, { withFileTypes: true });
  const files = await Promise.all(
    entries
      .filter((e) => e.isFile())
      .map(async (e) => {
        const stat = await fsp.stat(path.join(SHARED_DIR, e.name));
        return { name: e.name, size: stat.size, mtime: stat.mtimeMs };
      })
  );
  res.json(files.sort((a, b) => b.mtime - a.mtime));
});

app.get("/files/:name", (req, res) => {
  const name = req.params.name;
  if (name.includes("/") || name.includes("..")) return res.status(400).end();
  res.download(path.join(SHARED_DIR, name));
});

app.post("/files", upload.single("file"), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: "keine Datei" });
  try {
    const dest = path.join(SHARED_DIR, req.file.originalname);
    await fsp.rename(req.file.path, dest);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e instanceof Error ? e.message : String(e) });
  }
});

// --- Clipboard sync: the X CLIPBOARD selection of the remote desktop, read and
// written as UTF-8 text so the client can mirror it with the browser's own
// clipboard (see syncClipboard in static/index.html). ---

app.get("/clipboard", async (req, res) => {
  try {
    const text = await execFilePromise("xclip", ["-selection", "clipboard", "-o"]).catch(() => "");
    res.json({ text });
  } catch (e) {
    res.status(500).json({ error: e instanceof Error ? e.message : String(e) });
  }
});

app.post("/clipboard", express.json({ limit: "5mb" }), (req, res) => {
  const text = typeof req.body?.text === "string" ? req.body.text : null;
  if (text === null) return res.status(400).json({ error: "text fehlt" });
  // xclip forks into the background as the selection owner and keeps its
  // inherited pipes open, so stdout/stderr are not piped: answer when the
  // foreground process exits instead of waiting for the pipes to close.
  const child = spawn("xclip", ["-selection", "clipboard", "-i"], { env: childEnv, stdio: ["pipe", "ignore", "ignore"] });
  child.on("error", (err) => res.status(500).json({ error: err.message }));
  child.on("exit", (code) => (code === 0 ? res.json({ ok: true }) : res.status(500).json({ error: `xclip exit ${code}` })));
  child.stdin.end(text, "utf8");
});

app.get("/healthz", (req, res) => res.send("ok"));

initDesktop()
  .then(() => {
    app.listen(PORT, () => console.log(`desktop-relay listening on :${PORT}`));
  })
  .catch((e) => {
    console.error("Failed to start desktop:", e);
    process.exit(1);
  });
