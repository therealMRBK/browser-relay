/**
 * desktop-relay: a full Linux desktop (Xvfb + Fluxbox + a real, normally-
 * launched Google Chrome -- not driven via Playwright/CDP, so it is never
 * automation-flagged) captured by `ffmpeg -f x11grab` and handed to the client
 * as H.264 (WebCodecs) or JPEG frames over plain HTTP long polls (see the
 * "Video" block), controlled via plain HTTP POSTs (xhelper.c for the mouse,
 * xdotool for the keyboard).
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

// --- Video. Two pipelines, each an ffmpeg capturing the X display, started when a client first asks for frames and stopped
// again when nobody has asked for a while:
//
//   h264  H.264 for browsers with WebCodecs (GPU encoder via VAAPI, libx264 if that fails): about 1.5-6 Mbit/s.
//   jpeg  one JPEG per frame for everything else; a frame identical to the last one is not counted as new, so a still screen
//         costs nothing.
//
// Delivery is pull, one request per answer: the client asks for "anything after seq N", the server answers as soon as there
// is something newer (or after FRAME_WAIT_MS with 204). There is never more than one answer in flight per client, whatever
// sits in between. The old design streamed frames down one long response; behind a buffering reverse proxy (nginx reads the
// upstream as fast as it can and spools to disk) every frame the client could not take in time piled up there, so the picture
// fell further and further behind after a few seconds of use, until a reload.
//
// Neither pipeline draws the mouse pointer: the browser draws the real pointer shape itself (see /cursor), so it never lags.
const FRAME_WAIT_MS = 15000;
const PIPELINE_IDLE_MS = 15000;
// a client further behind than this many H.264 frames skips ahead to the newest keyframe instead of catching up frame by frame
const H264_MAX_LAG = TARGET_FPS;
const H264_GOP = TARGET_FPS; // a keyframe every second: bounds how long a skip ahead can take
// Bitrate steps (average / peak). A still screen needs about 0.2 Mbit/s at any step (a constant-bitrate setting filled even
// that up to the full rate). When a client keeps having to skip ahead, its line is slower than the stream: the encoder
// restarts one step lower. After a minute without skips it tries one step higher again.
const H264_STEPS = [
  [process.env.H264_BITRATE || "3M", process.env.H264_MAXRATE || "8M"],
  ["1500k", "4M"],
  ["800k", "2M"],
  ["400k", "1M"],
];
const H264_STEP_UP_MS = 60000;
const JPEG_QUALITY = process.env.JPEG_QUALITY || "7"; // ffmpeg -q:v, 2 (best) .. 31; was 5

function makePipeline(name) {
  return { name, proc: null, wanted: false, restartExpected: false, lastPoll: 0, startedAt: 0, produced: 0, waiters: new Set(), buffer: Buffer.alloc(0), seq: 0 };
}
const jpeg = Object.assign(makePipeline("jpeg"), { frame: null });
const h264 = Object.assign(makePipeline("h264"), {
  encoder: process.env.H264_ENCODER || "vaapi",
  frames: [], // {seq, key, data}, the newest last
  au: [], // NAL units of the access unit being collected
  sps: null,
  pps: null,
  codec: null,
  epoch: 0, // bumped for every new ffmpeg: frames of different epochs cannot be decoded one after the other
  width: 0,
  height: 0,
  step: 0, // index into H264_STEPS
  skips: [], // times a continuing client was made to skip ahead
  stepChangedAt: 0,
});

function setH264Step(step) {
  if (step === h264.step) return;
  console.error(`h264: bitrate step ${h264.step} -> ${step} (${H264_STEPS[step][0]} / ${H264_STEPS[step][1]})`);
  h264.step = step;
  h264.stepChangedAt = Date.now();
  h264.skips = [];
  if (h264.proc) {
    h264.restartExpected = true;
    h264.proc.kill("SIGTERM");
  }
}

function noteH264Skip() {
  const now = Date.now();
  h264.skips = h264.skips.filter((t) => now - t < 20000);
  h264.skips.push(now);
  // two skips in 20 s, and the last change was a while ago (the new step needs a moment to show its effect)
  if (h264.skips.length >= 2 && now - h264.stepChangedAt > 5000 && h264.step < H264_STEPS.length - 1) setH264Step(h264.step + 1);
}

setInterval(() => {
  const quiet = Date.now() - Math.max(h264.stepChangedAt, h264.skips[h264.skips.length - 1] || 0);
  if (h264.proc && h264.step > 0 && quiet > H264_STEP_UP_MS) setH264Step(h264.step - 1);
}, 5000);

function wake(p) {
  for (const w of p.waiters) w();
}

function captureInput() {
  return ["-f", "x11grab", "-draw_mouse", "0", "-framerate", String(TARGET_FPS), "-video_size", `${DISPLAY_WIDTH}x${DISPLAY_HEIGHT}`, "-i", DISPLAY];
}

function pipelineArgs(p) {
  if (p === jpeg) return ["-loglevel", "error", ...captureInput(), "-f", "mpjpeg", "-boundary_tag", MJPEG_BOUNDARY, "-q:v", JPEG_QUALITY, "-flush_packets", "1", "pipe:1"];
  const [bitrate, maxrate] = H264_STEPS[h264.step];
  const common = ["-g", String(H264_GOP), "-bf", "0", "-maxrate", maxrate, "-flush_packets", "1", "-f", "h264", "pipe:1"];
  if (h264.encoder === "vaapi") {
    const vaapi = ["-c:v", "h264_vaapi", "-rc_mode", "VBR", "-b:v", bitrate, "-aud", "1", "-async_depth", "1"];
    return ["-loglevel", "error", "-vaapi_device", "/dev/dri/renderD128", ...captureInput(), "-vf", "format=nv12,hwupload", ...vaapi, ...common];
  }
  const x264 = ["-c:v", "libx264", "-preset", "ultrafast", "-tune", "zerolatency", "-crf", "23", "-bufsize", maxrate, "-x264-params", "aud=1:repeat-headers=1"];
  return ["-loglevel", "error", ...captureInput(), "-vf", "format=yuv420p", ...x264, ...common];
}

function startPipeline(p) {
  p.wanted = true;
  if (p.proc) return;
  p.buffer = Buffer.alloc(0);
  p.startedAt = Date.now();
  p.produced = 0;
  if (p === h264) {
    h264.epoch++;
    h264.frames = [];
    h264.au = [];
    h264.width = DISPLAY_WIDTH;
    h264.height = DISPLAY_HEIGHT;
  }
  const proc = spawn("ffmpeg", pipelineArgs(p), { env: childEnv, stdio: ["ignore", "pipe", "pipe"] });
  proc.stdout.on("data", (chunk) => (p === jpeg ? parseJpegChunk(chunk) : parseH264Chunk(chunk)));
  proc.stderr.on("data", (d) => process.stderr.write(`[ffmpeg ${p.name}] ${d}`));
  proc.on("exit", (code, signal) => {
    p.proc = null;
    if (!p.wanted) return;
    if (p.restartExpected) {
      p.restartExpected = false;
      return startPipeline(p);
    }
    // the GPU encoder died before its first frame: not available here, use the CPU encoder from now on
    if (p === h264 && h264.encoder === "vaapi" && p.produced === 0) {
      console.error("h264_vaapi failed, switching to libx264");
      h264.encoder = "x264";
      return startPipeline(p);
    }
    console.error(`ffmpeg ${p.name} exited (code=${code}, signal=${signal}) -- restarting in 1s`);
    setTimeout(() => p.wanted && startPipeline(p), 1000);
  });
  p.proc = proc;
}

function stopPipeline(p) {
  p.wanted = false;
  if (p.proc) p.proc.kill("SIGTERM");
}

// after a resize: ffmpeg's capture size is fixed when it starts
function restartPipelines() {
  for (const p of [jpeg, h264]) {
    if (!p.proc) continue;
    p.restartExpected = true;
    p.proc.kill("SIGTERM");
  }
}

// nobody asked for frames for a while (tab closed, switched to the other mode): stop encoding
setInterval(() => {
  for (const p of [jpeg, h264]) if (p.wanted && Date.now() - p.lastPoll > PIPELINE_IDLE_MS && p.waiters.size === 0) stopPipeline(p);
}, 3000);

// ffmpeg's mpjpeg output: "Content-type: image/jpeg\r\nContent-length: N\r\n\r\n<N bytes>" parts
const HEADER_RE = /Content-type: image\/jpeg\r\nContent-length: (\d+)\r\n\r\n/i;
function parseJpegChunk(chunk) {
  jpeg.buffer = jpeg.buffer.length ? Buffer.concat([jpeg.buffer, chunk]) : chunk;
  for (;;) {
    const match = HEADER_RE.exec(jpeg.buffer.toString("latin1", 0, Math.min(jpeg.buffer.length, 256)));
    if (!match) {
      if (jpeg.buffer.length > 256) jpeg.buffer = jpeg.buffer.subarray(jpeg.buffer.length - 256);
      return;
    }
    const headerEnd = match.index + match[0].length;
    const length = parseInt(match[1], 10);
    if (jpeg.buffer.length < headerEnd + length) return;
    const frame = Buffer.from(jpeg.buffer.subarray(headerEnd, headerEnd + length));
    jpeg.buffer = jpeg.buffer.subarray(headerEnd + length);
    jpeg.produced++;
    // the encoder is deterministic: an unchanged screen gives the same bytes, and that is no new frame
    if (jpeg.frame && jpeg.frame.equals(frame)) continue;
    jpeg.frame = frame;
    jpeg.seq++;
    wake(jpeg);
  }
}

// ffmpeg's raw H.264 (Annex B): NAL units behind 00 00 01 start codes, every access unit (frame) opened by an AUD (type 9).
// A frame is complete when the next AUD arrives, so it goes out one frame late (1/TARGET_FPS s) - the price for knowing where
// it ends.
const START_CODE = Buffer.from([0, 0, 1]);
const START_CODE_4 = Buffer.from([0, 0, 0, 1]);
function parseH264Chunk(chunk) {
  let buf = h264.buffer.length ? Buffer.concat([h264.buffer, chunk]) : chunk;
  let at = buf.indexOf(START_CODE);
  if (at < 0) {
    h264.buffer = buf;
    return;
  }
  for (;;) {
    const next = buf.indexOf(START_CODE, at + 3);
    if (next < 0) break;
    // a 4-byte start code's leading zero is not part of the NAL before it
    const end = next > 0 && buf[next - 1] === 0 ? next - 1 : next;
    onNal(Buffer.from(buf.subarray(at + 3, end)));
    at = next;
  }
  h264.buffer = buf.subarray(at);
}

function onNal(nal) {
  if (!nal.length) return;
  const type = nal[0] & 0x1f;
  if (type === 9) {
    if (h264.au.some((n) => (n[0] & 0x1f) >= 1 && (n[0] & 0x1f) <= 5)) emitAccessUnit(h264.au);
    h264.au = [];
    return;
  }
  if (type === 7) {
    h264.sps = nal;
    h264.codec = `avc1.${[nal[1], nal[2], nal[3]].map((b) => b.toString(16).padStart(2, "0")).join("")}`;
  }
  if (type === 8) h264.pps = nal;
  h264.au.push(nal);
}

function emitAccessUnit(nals) {
  const key = nals.some((n) => (n[0] & 0x1f) === 5);
  // a keyframe has to carry SPS/PPS itself: it is where a decoder starts
  if (key && !nals.some((n) => (n[0] & 0x1f) === 7) && h264.sps && h264.pps) nals = [h264.sps, h264.pps, ...nals];
  const data = Buffer.concat(nals.flatMap((n) => [START_CODE_4, n]));
  h264.produced++;
  h264.frames.push({ seq: ++h264.seq, key, data });
  // keep the newest keyframe and everything after it, and at least 2 s
  const lastKey = h264.frames.findLastIndex((f) => f.key);
  const keepFrom = Math.max(0, Math.min(lastKey < 0 ? 0 : lastKey, h264.frames.length - 2 * TARGET_FPS));
  if (keepFrom > 0) h264.frames.splice(0, keepFrom);
  wake(h264);
}

// The H.264 frames a client needs after `after`: the next ones in order, or - for a new client, a new epoch, or one too far
// behind - everything from the newest keyframe on.
function h264FramesFor(after, epoch) {
  const frames = h264.frames;
  if (!frames.length || !h264.codec) return [];
  const latest = frames[frames.length - 1].seq;
  if (after >= latest && epoch === h264.epoch) return [];
  const continuing = epoch === h264.epoch && frames[0].seq <= after + 1 && latest - after <= H264_MAX_LAG;
  if (continuing) return frames.filter((f) => f.seq > after);
  const lastKey = frames.findLastIndex((f) => f.key);
  if (lastKey < 0) return [];
  // the newest keyframe is not newer than what the client has: wait for the next one rather than going back in time
  if (epoch === h264.epoch && frames[lastKey].seq <= after) return [];
  if (epoch === h264.epoch && after >= 0) noteH264Skip();
  return frames.slice(lastKey);
}

// Waits until `ready()` returns something or FRAME_WAIT_MS passes; answers 204 then. Ends early if the client goes away.
function longPoll(p, req, res, ready, send) {
  p.lastPoll = Date.now();
  const now = ready();
  if (now) return send(now);
  let done = false;
  const finish = (value) => {
    if (done) return;
    done = true;
    clearTimeout(timer);
    p.waiters.delete(check);
    p.lastPoll = Date.now();
    if (value) send(value);
    else if (!res.writableEnded) res.status(204).end();
  };
  const check = () => {
    const value = ready();
    if (value) finish(value);
  };
  const timer = setTimeout(() => finish(null), FRAME_WAIT_MS);
  p.waiters.add(check);
  req.on("close", () => finish(null));
}

// --- Pointer and mouse: one long-running xhelper (xhelper.c) instead of an xdotool process per event, and the source of the
// pointer's shape for the browser. xdotool stays for the keyboard (its `type` handles any Unicode text). ---
let helper = null;
let cursor = null; // {version, serial, w, h, xhot, yhot, rgba}
let cursorVersion = 0;
const cursorWaiters = makePipeline("cursor"); // only its waiters/lastPoll are used

// German characters on spare keys (unused multimedia keycodes) of the US keymap. Without them `xdotool type` remaps a scratch
// key for every ä/ö/ü/ß/€ on the fly, and Chrome sometimes reads the key before the new mapping: about one word in six lost a
// character. Free keycodes stay free for xdotool's on-the-fly mapping of rarer characters. Runs with every helper start,
// which follows every Xvfb (re)start, since a new X server starts with the plain keymap.
const GERMAN_KEYS = [
  "keycode 189 = adiaeresis Adiaeresis",
  "keycode 191 = odiaeresis Odiaeresis",
  "keycode 192 = udiaeresis Udiaeresis",
  "keycode 193 = ssharp U1E9E",
  "keycode 194 = EuroSign section",
  "keycode 195 = degree mu",
  "keycode 196 = twosuperior threesuperior",
];

let germanKeysAt = 0;
// Once seen lost right after the very first start (some X client reset the keymap), so it is also re-applied before typing
// such characters, at most every 10 s; it is idempotent and takes a few ms.
async function ensureGermanKeys(force = false) {
  if (!force && Date.now() - germanKeysAt < 10000) return;
  germanKeysAt = Date.now();
  await execFilePromise("xmodmap", GERMAN_KEYS.flatMap((line) => ["-e", line])).catch((e) => console.error(`xmodmap failed: ${e.message}`));
}

function startHelper() {
  ensureGermanKeys(true);
  let out = "";
  const proc = spawn(path.join(__dirname, "xhelper"), [], { env: childEnv, stdio: ["pipe", "pipe", "pipe"] });
  proc.stdout.on("data", (d) => {
    out += d.toString("latin1");
    let nl;
    while ((nl = out.indexOf("\n")) >= 0) {
      const line = out.slice(0, nl);
      out = out.slice(nl + 1);
      const [tag, serial, w, h, xhot, yhot, rgba = ""] = line.split(" ");
      if (tag !== "C") continue;
      cursor = { version: ++cursorVersion, serial: Number(serial), w: Number(w), h: Number(h), xhot: Number(xhot), yhot: Number(yhot), rgba };
      wake(cursorWaiters);
    }
  });
  proc.stderr.on("data", (d) => process.stderr.write(`[xhelper] ${d}`));
  proc.stdin.on("error", () => {});
  proc.on("error", (e) => console.error(`xhelper failed to start: ${e.message}`));
  proc.on("exit", (code) => {
    if (helper === proc) helper = null;
    console.error(`xhelper exited (code=${code}) -- restarting in 2s`);
    setTimeout(startHelper, 2000);
  });
  helper = proc;
}

// sends lines to xhelper; without it (not built, crashed) the same through xdotool
async function pointer(lines) {
  if (helper && helper.stdin.writable) {
    helper.stdin.write(lines.join("\n") + "\n");
    return;
  }
  for (const line of lines) {
    const [op, a, b] = line.split(" ");
    if (op === "m") await xdotool(["mousemove", a, b]);
    else if (op === "d") await xdotool(["mousedown", a]);
    else if (op === "u") await xdotool(["mouseup", a]);
    else if (op === "c") await xdotool(["click", "--repeat", b, a]);
  }
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

  // cvt may round the mode; capture exactly what the screen now is (a too-large x11grab size makes ffmpeg fail)
  const current = /current (\d+) x (\d+)/.exec(await execFilePromise("xrandr", []));
  DISPLAY_WIDTH = current ? parseInt(current[1], 10) : width;
  DISPLAY_HEIGHT = current ? parseInt(current[2], 10) : height;
  restartPipelines();

  await xdotool(["getactivewindow", "windowsize", String(DISPLAY_WIDTH), String(DISPLAY_HEIGHT)]).catch(() => {});
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

  startHelper();
  startAudioCapture();
}

const app = express();
app.use((req, res, next) => (req.path === "/clipboard" ? next() : express.json()(req, res, next)));
// long polls and streams must reach the client as they are: tells a reverse proxy like nginx (NPM) not to buffer them
app.use((req, res, next) => {
  res.setHeader("X-Accel-Buffering", "no");
  next();
});
const upload = multer({ dest: UPLOAD_TMP_DIR });

app.get("/", (req, res) => {
  res.sendFile(__dirname + "/static/index.html");
});
app.use("/static", express.static(__dirname + "/static"));

app.get("/info", (req, res) => {
  res.json({ width: DISPLAY_WIDTH, height: DISPLAY_HEIGHT, fps: TARGET_FPS, encoder: h264.encoder, h264Step: H264_STEPS[h264.step].join("/"), h264Seq: h264.seq, jpegSeq: jpeg.seq });
});

app.post("/resize", async (req, res) => {
  // the H.264 encoders want even sizes; widths in steps of 8 match what cvt produces anyway
  const width = Math.max(320, Math.min(3840, parseInt(req.body?.width, 10) || DISPLAY_WIDTH)) & ~7;
  const height = Math.max(240, Math.min(2160, parseInt(req.body?.height, 10) || DISPLAY_HEIGHT)) & ~1;
  if (width === DISPLAY_WIDTH && height === DISPLAY_HEIGHT) {
    return res.json({ ok: true, width, height, changed: false });
  }
  try {
    await resizeDisplay(width, height);
    res.json({ ok: true, width: DISPLAY_WIDTH, height: DISPLAY_HEIGHT, changed: true });
  } catch (e) {
    res.status(500).json({ error: e instanceof Error ? e.message : String(e) });
  }
});

// The newest JPEG frame once it is newer than `after` (X-Seq tells its number).
app.get("/video/jpeg", (req, res) => {
  const after = parseInt(req.query.after, 10) || 0;
  startPipeline(jpeg);
  longPoll(jpeg, req, res, () => jpeg.frame && jpeg.seq > after && { frame: jpeg.frame, seq: jpeg.seq }, ({ frame, seq }) => {
    res.writeHead(200, { "Content-Type": "image/jpeg", "Content-Length": frame.length, "X-Seq": String(seq), "Cache-Control": "no-store" });
    res.end(frame);
  });
});

// H.264 frames after `after` of encoder run `epoch`, as one binary answer: per frame a 4-byte seq, a 1-byte keyframe flag, a
// 4-byte length and the Annex B data. X-Codec / X-Epoch / X-Width / X-Height describe the stream; a client whose epoch differs
// gets everything from the newest keyframe and has to configure a new decoder.
app.get("/video/h264", (req, res) => {
  const after = parseInt(req.query.after, 10);
  const epoch = parseInt(req.query.epoch, 10);
  startPipeline(h264);
  longPoll(h264, req, res, () => {
    const frames = h264FramesFor(Number.isNaN(after) ? -1 : after, Number.isNaN(epoch) ? -1 : epoch);
    return frames.length > 0 && frames;
  }, (frames) => {
    const parts = [];
    for (const f of frames) {
      const head = Buffer.alloc(9);
      head.writeUInt32BE(f.seq, 0);
      head.writeUInt8(f.key ? 1 : 0, 4);
      head.writeUInt32BE(f.data.length, 5);
      parts.push(head, f.data);
    }
    const body = Buffer.concat(parts);
    res.writeHead(200, {
      "Content-Type": "application/octet-stream",
      "Content-Length": body.length,
      "Cache-Control": "no-store",
      "X-Codec": h264.codec,
      "X-Epoch": String(h264.epoch),
      "X-Width": String(h264.width),
      "X-Height": String(h264.height),
      "X-Encoder": h264.encoder,
      "X-Bitrate": H264_STEPS[h264.step][0],
    });
    res.end(body);
  });
});

// The pointer's current shape once it differs from version `after`: {version, w, h, xhot, yhot, rgba (hex)}.
app.get("/cursor", (req, res) => {
  const after = parseInt(req.query.after, 10) || 0;
  longPoll(cursorWaiters, req, res, () => cursor && cursor.version > after && cursor, (c) => res.json(c));
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

const BUTTONS = { left: 1, middle: 2, right: 3 };

function xdotoolKeyCombo(key) {
  // "Control+Shift+T"-style combo strings (see static/index.html) split
  // into xdotool's lowercase-modifier "ctrl+shift+t" syntax. Critically,
  // a bare letter must be lowercased unless "Shift" is explicitly one of
  // the parts: X11 keysym "A" *is* shift+a, so "ctrl+A" from xdotool's
  // perspective means Ctrl+Shift+a, not plain Ctrl+A -- the client
  // already adds an explicit "Shift" part when it means to shift.
  return key
    .split("+")
    .map((p) => MODIFIER_TO_XDOTOOL[p] || NAMED_KEY_TO_XDOTOOL[p] || (p.length === 1 ? p.toLowerCase() : p))
    .join("+");
}

// All input in one ordered batch: the client keeps a single request in flight and collects what happens meanwhile (moves
// merged into the newest one, typed characters into one string), so input can never pile up behind a slow connection.
// Events: {t:"move",x,y} {t:"down",x,y,b} {t:"up",b} {t:"wheel",dx,dy} {t:"key",key} {t:"type",text}
app.post("/input", async (req, res) => {
  const events = Array.isArray(req.body?.events) ? req.body.events.slice(0, 500) : [];
  try {
    for (const e of events) {
      const button = BUTTONS[e.b] || 1;
      if (e.t === "move") await pointer([`m ${e.x | 0} ${e.y | 0}`]);
      else if (e.t === "down") await pointer([`m ${e.x | 0} ${e.y | 0}`, `d ${button}`]);
      else if (e.t === "up") await pointer([`u ${button}`]);
      else if (e.t === "wheel") {
        const lines = [];
        const steps = (d) => Math.min(10, Math.max(1, Math.round(Math.abs(d) / 50)));
        if (Math.abs(e.dy || 0) >= 1) lines.push(`c ${e.dy > 0 ? 5 : 4} ${steps(e.dy)}`);
        if (Math.abs(e.dx || 0) >= 1) lines.push(`c ${e.dx > 0 ? 7 : 6} ${steps(e.dx)}`);
        if (lines.length) await pointer(lines);
      } else if (e.t === "key" && typeof e.key === "string") await xdotool(["key", xdotoolKeyCombo(e.key)]);
      else if (e.t === "type" && typeof e.text === "string" && e.text) {
        if (/[^\x00-\x7f]/.test(e.text)) await ensureGermanKeys();
        await xdotool(["type", "--", e.text]);
      }
    }
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
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
