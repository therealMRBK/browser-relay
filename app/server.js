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

const childEnv = { ...process.env, DISPLAY };

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

function spawnPersistent(name, command, args) {
  const proc = spawn(command, args, { env: childEnv, stdio: ["ignore", "pipe", "pipe"] });
  proc.on("exit", (code, signal) => {
    console.error(`${name} exited (code=${code}, signal=${signal}) -- restarting in 2s`);
    setTimeout(() => spawnPersistent(name, command, args), 2000);
  });
  proc.stderr.on("data", (d) => process.stderr.write(`[${name}] ${d}`));
  return proc;
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
// head" at the top of the captured video. There's exactly one window that
// ever exists in this desktop (Chrome), so removing decorations for it
// entirely is correct, not just a workaround -- also reclaims that strip of
// screen space for actual content. Same as seedFluxboxInit, this file isn't
// on the persistent volume and must be rewritten every container start.
async function seedFluxboxApps() {
  const fluxboxDir = path.join(process.env.HOME || "/root", ".fluxbox");
  await fsp.mkdir(fluxboxDir, { recursive: true });
  const appsPath = path.join(fluxboxDir, "apps");
  await fsp.writeFile(appsPath, "[app] (class=Google-chrome)\n [Deco]\t{NONE}\n[end]\n");
}

async function initDesktop() {
  await fsp.mkdir(PROFILE_DIR, { recursive: true });
  await fsp.mkdir(SHARED_DIR, { recursive: true });
  await fsp.mkdir(UPLOAD_TMP_DIR, { recursive: true });
  await seedChromePreferences();

  spawnPersistent("Xvfb", "Xvfb", [DISPLAY, "-screen", "0", `${DISPLAY_WIDTH}x${DISPLAY_HEIGHT}x24`, "-nolisten", "tcp", "-ac"]);
  await waitForX11Socket();

  await seedFluxboxInit();
  await seedFluxboxApps();
  spawnPersistent("fluxbox", "fluxbox", []);
  await new Promise((r) => setTimeout(r, 1000));

  // No --enable-automation, no CDP, no remote-debugging-port -- a normal
  // Chrome launch, indistinguishable from a real user's browser.
  spawnPersistent("chrome", "google-chrome", [
    `--user-data-dir=${PROFILE_DIR}`,
    "--no-sandbox", // required running as root in a container; unrelated to automation flagging
    "--no-first-run",
    "--no-default-browser-check",
    "--password-store=basic",
    "--window-position=0,0",
    `--window-size=${DISPLAY_WIDTH},${DISPLAY_HEIGHT}`,
    "about:blank",
  ]);

  startFfmpegCapture();
}

const app = express();
app.use(express.json());
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

app.get("/healthz", (req, res) => res.send("ok"));

initDesktop()
  .then(() => {
    app.listen(PORT, () => console.log(`desktop-relay listening on :${PORT}`));
  })
  .catch((e) => {
    console.error("Failed to start desktop:", e);
    process.exit(1);
  });
