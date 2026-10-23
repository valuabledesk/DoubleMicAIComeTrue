#!/usr/bin/env node
'use strict';

const childProcess = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const net = require('net');
const os = require('os');
const path = require('path');
const url = require('url');

const VERSION = '0.2.29';
const DEFAULT_PORT = 8900;
// Sample interval file polled by the board-side rockaa_perf sampler;
// the env only seeds the initial interval at process start.
const PERF_INTERVAL_FILE = '/tmp/rockaa_perf_interval';
const HOST = process.env.ROCKAA_BRIDGE_HOST || '127.0.0.1';
const REQUESTED_PORT = Number(process.env.ROCKAA_BRIDGE_PORT || DEFAULT_PORT);
let bridgePort = REQUESTED_PORT;
const AUTO_PORT = process.env.ROCKAA_BRIDGE_AUTO_PORT === '1'
  || (!process.env.ROCKAA_BRIDGE_PORT && process.env.ROCKAA_BRIDGE_AUTO_PORT !== '0');
const MAX_AUTO_PORT = DEFAULT_PORT + 20;
const HTML_ROOT = path.resolve(__dirname, '..');
const DASHBOARD_ROOT = path.resolve(HTML_ROOT, '..');
const SAMPLE_RATE = 16000;
const BITS = 16;
const NB_SAMPLES = 256;
const STREAM_HEADER_SIZE = 16;
const MAX_RX_SOURCE_BYTES = 256 * 1024 * 1024;
const STOP_REQUESTED = process.argv.includes('--stop');
const OPEN_REQUESTED = process.argv.includes('--open') || process.env.ROCKAA_OPEN_BROWSER === '1';

function requestBridgeShutdown() {
  const req = http.request({
    host: HOST,
    port: bridgePort,
    path: '/__bridge/shutdown?reason=npm-stop',
    method: 'POST',
    timeout: 1000,
  }, res => {
    res.resume();
    res.on('end', () => process.exit(0));
  });
  req.on('timeout', () => {
    req.destroy();
    process.exit(1);
  });
  req.on('error', err => {
    console.error(`bridge shutdown request failed: ${err.message}`);
    process.exit(1);
  });
  req.end();
}

const MIME_TYPES = {
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.wav': 'audio/wav',
};

const clients = new Set();

// ── Auto-Tuning session (single global instance, mutex across tabs) ──
const autotuneSession = {
  child: null,        // child_process handle when running
  pid: 0,
  kind: '',           // 'tune' | 'eval' | 'hardware'
  startedAt: 0,
  clients: new Set(), // subscribed WebSets
  history: [],        // recent broadcast messages (cap 200)
  busy: false,        // mutex for handlers that await before spawning child
};

function autotuneBusy() {
  return autotuneSession.child !== null || autotuneSession.busy === true;
}

function autotuneBroadcast(body) {
  // Don't mutate caller's object
  const msg = Object.assign({}, body);
  autotuneSession.history.push(msg);
  if (autotuneSession.history.length > 200) autotuneSession.history.shift();
  for (const c of autotuneSession.clients) sendJson(c, msg);
}

function autotuneChildDied() {
  autotuneSession.child = null;
  autotuneSession.busy = false;
  autotuneSession.pid = 0;
  autotuneSession.kind = '';
}

// Path to Python CLI — relative to repo root (one level up from DASHBOARD_ROOT,
// since tools/auto_tuning/ lives at rockaa/tools/auto_tuning/, not under dashboard/)
const AUTOTUNE_CLI = path.join(DASHBOARD_ROOT, '..', 'tools', 'auto_tuning', 'autotune_cli.py');
const AUTOTUNE_PYTHON = process.env.AUTOTUNE_PYTHON || 'python3';
// Working VQE .so (Phase 1 smoke test verified this path; the
// thirdparty/libs/vqe_v1 copy SEGFAULTs during ctypes init)
const AUTOTUNE_SO = path.join(DASHBOARD_ROOT, '..', 'tools', 'auto_tuning', 'lib', 'librkaudio_vqe.so');

// Bundled 3A-standard reference signals for hardware acceptance playback.
// Preferred over `autotune_cli.py gen-signal` because:
//   - sweep band matches the calibration spec (20-Nyquist, not staging's 20-8k)
//   - duration is the standard 10 s (5 s default from gen-signal truncated
//     the sweep and broke H4 THD band coverage)
//   - amplitude/crest characteristics are reproducible across runs
// Override per-env if a deploy needs to ship a different set.
const HW_REFERENCE_DIR = process.env.ROCKAA_HW_REFERENCE_DIR
  || path.join(DASHBOARD_ROOT, '..', 'tools', 'auto_tuning', 'hw_reference');
// Lookup table: sampleRate → { signalType → filename }. Files are looked up
// under `<HW_REFERENCE_DIR>/<rate>/`. Missing entries fall back to gen-signal.
const HW_REFERENCE_FILES = {
  48000: {
    sweep: 'sweep-48k-16bit-2ch.wav',
    '1k': '1k-48k-16bit-2ch.wav',
    whitenoise: 'whitenoise-48k-16bit-2ch.wav',
  },
  16000: {
    sweep: 'sweep-16k-16bit-2ch.wav',
    '1k': '1k-16k-16bit-2ch.wav',
    whitenoise: 'whitenoise-16k-16bit-2ch.wav',
  },
};

// Read a WAV's duration (seconds) from its header without loading samples.
// Returns null on malformed/missing file. Used so tinycap's -T matches the
// actual playback file rather than a fixed 5 s default (mismatch truncates
// the captured sweep and breaks H4 THD band analysis).
function readWavDurationSec(wavPath) {
  try {
    const fd = fs.openSync(wavPath, 'r');
    try {
      // Read up to 2048 bytes — covers header + any LIST/fmt-extension chunks
      // before the "data" chunk. bytes 22-23 = channels, 24-27 = sampleRate.
      const headerBuf = Buffer.alloc(2048);
      const hn = fs.readSync(fd, headerBuf, 0, 2048, 0);
      if (hn < 44) return null;
      if (headerBuf.toString('ascii', 0, 4) !== 'RIFF' || headerBuf.toString('ascii', 8, 12) !== 'WAVE') return null;
      const sampleRate = headerBuf.readUInt32LE(24);
      const bytesPerSample = headerBuf.readUInt16LE(34) / 8;
      const channels = headerBuf.readUInt16LE(22);
      let dataBytes = null;
      for (let i = 12; i + 8 <= hn; i++) {
        if (headerBuf.toString('ascii', i, i + 4) === 'data') {
          dataBytes = headerBuf.readUInt32LE(i + 4);
          break;
        }
      }
      if (!dataBytes || !sampleRate || !bytesPerSample || !channels) return null;
      return dataBytes / (sampleRate * channels * bytesPerSample);
    } finally {
      fs.closeSync(fd);
    }
  } catch (e) {
    return null;
  }
}

function readWavSampleRate(wavPath) {
  try {
    const header = Buffer.alloc(28);
    const fd = fs.openSync(wavPath, 'r');
    try {
      if (fs.readSync(fd, header, 0, header.length, 0) !== header.length) return null;
    } finally {
      fs.closeSync(fd);
    }
    if (header.toString('ascii', 0, 4) !== 'RIFF'
        || header.toString('ascii', 8, 12) !== 'WAVE') return null;
    return header.readUInt32LE(24) || null;
  } catch (_) {
    return null;
  }
}

async function autotunePreflight() {
  // Verify python3 + key imports are available
  try {
    const result = await new Promise((resolve) => {
      const child = childProcess.spawn(AUTOTUNE_PYTHON, ['-c',
        'import numpy, scipy, optuna; print("ok")'], { shell: false });
      let out = '', err = '';
      child.stdout.on('data', d => out += d);
      child.stderr.on('data', d => err += d);
      child.on('close', code => resolve({ code, out, err }));
      child.on('error', e => resolve({ code: -1, err: String(e) }));
    });
    if (result.code !== 0) {
      return {
        ok: false,
        message: `Python deps missing. Install with: pip install -r tools/auto_tuning/requirements.txt (${result.err.trim()})`,
      };
    }
    if (!fs.existsSync(AUTOTUNE_CLI)) {
      return { ok: false, message: `autotune_cli.py not found at ${AUTOTUNE_CLI}` };
    }
    return { ok: true };
  } catch (e) {
    return { ok: false, message: `python3 not found: ${e.message}` };
  }
}

function autotuneRunToCompletion(args, { timeoutMs = 120000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = childProcess.spawn(AUTOTUNE_PYTHON, args, { shell: false });
    autotuneSession.child = child;
    autotuneSession.pid = child.pid;

    let stdout = '', stderr = '';
    let lastDoc = null;  // last complete JSON doc seen on stdout
    child.stdout.on('data', d => {
      stdout += d.toString();
      // Stream complete lines if anyone is subscribed
      const lines = stdout.split('\n');
      stdout = lines.pop();  // keep partial last line
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const obj = JSON.parse(line);
          lastDoc = obj;  // remember most-recent parsed doc
          // Namespacize type field: "progress" -> "autotune.progress" etc.
          const evt = Object.assign({ sessionId: autotuneSession.startedAt }, obj);
          if (obj.type) evt.type = `autotune.${obj.type}`;
          else evt.type = 'autotune.line';
          autotuneBroadcast(evt);
        } catch (e) {
          // Non-JSON line; treat as log
          autotuneBroadcast({ type: 'autotune.log', message: line });
        }
      }
    });
    child.stderr.on('data', d => { stderr += d.toString(); });

    const timer = setTimeout(() => {
      child.kill('SIGINT');
      setTimeout(() => child.kill('SIGKILL'), 5000);
      reject(new Error(`autotune timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    child.on('error', err => { clearTimeout(timer); autotuneChildDied(); reject(err); });
    child.on('close', code => {
      clearTimeout(timer);
      autotuneChildDied();
      // Parse any final trailing line (CLI may emit last doc without newline)
      if (stdout.trim()) {
        try {
          const obj = JSON.parse(stdout.trim());
          lastDoc = obj;
          const evt = Object.assign({ sessionId: autotuneSession.startedAt }, obj);
          evt.type = obj.type ? `autotune.${obj.type}` : 'autotune.line';
          autotuneBroadcast(evt);
          stdout = '';
        } catch (e) { /* leave stdout intact for error diagnostics */ }
      }
      if (code === 0) {
        if (lastDoc !== null) {
          resolve(lastDoc);
        } else {
          reject(new Error(`autotune produced no JSON: ${stdout.slice(-500)}`));
        }
      } else {
        // Try to extract error JSON (CLI emits {type:error,message} on failure)
        if (lastDoc && lastDoc.type === 'error') {
          reject(new Error(lastDoc.message || 'autotune failed'));
          return;
        }
        reject(new Error(`autotune exited ${code}: ${stderr.trim().slice(-500)}`));
      }
    });
  });
}

// ── Hardware acceptance collection helpers ──
// Per signal type, map to the gen-signal test name. The CLI's gen-signal
// dispatch table knows sine/multitone/sweep/white_noise/pink_noise/pulse/
// mls/thd — we use a subset for the 5 standard hw signals.
const HW_SIGNAL_GEN_TEST = {
  sweep: 'sweep',
  '1k': 'sine',
  whitenoise: 'white_noise',
  whitenoise_sealed: 'white_noise',
  silence: null,  // no playback — record ambient only
};

// tinyplay/tinycap invocation. tinycap records into a WAV at the requested
// channel count + sample rate. tinyplay plays back the generated signal.
// We use nohup so tinyplay ignores SIGHUP if the parent adb shell exits
// before it finishes, and a 0.3 s lead-in so tinyplay has opened the ALSA
// device before tinycap starts pulling samples. Both stderr streams are
// tee'd to a logfile that we cat back so device-side errors (HAL
// exclusive-access, wrong route, etc.) are visible in the UI rather than
// producing a silently empty WAV.
//
// Card index: Rockchip boards typically expose card 0 = HDMI and card 1 =
// the real codec (e.g. ES7210 ADC + ES730 DAC). tinycap on card 0 returns
// empty/silence. Playback and capture may live on DIFFERENT cards (e.g.
// external USB DAC for playback while the on-board codec captures), so they
// take separate indices. Both default to 1 and are overridable via
// message.playbackCard / message.captureCard.
function tinyplayTinycapShellCmd(signalRemote, captureRemote, sampleRate, numChannels, durationSec, logPath, playbackCard, captureCard) {
  const pCard = Number.isInteger(playbackCard) ? playbackCard : 1;
  const cCard = Number.isInteger(captureCard) ? captureCard : 1;
  const period = 1024;
  const nper = 4;
  const cap = `tinycap ${shellQuote(captureRemote)} -D ${cCard} -c ${numChannels} -r ${sampleRate} -b 16 -p ${period} -n ${nper} -T ${durationSec}`;
  if (!signalRemote) {
    return `${cap} 2>>${shellQuote(logPath)}; echo "cap_rc=$?"`;
  }
  // Background tinyplay into its own process group. When adb shell returns,
  // Android init may SIGHUP the whole process group, so we wrap tinyplay with
  // nohup to make it ignore SIGHUP. A pidfile ensures we kill the right process
  // (setsid would fork, making $! capture the parent, not tinyplay).
  return [
    `: > ${shellQuote(logPath)}`,
    `nohup tinyplay ${shellQuote(signalRemote)} -D ${pCard} >>${shellQuote(logPath)} 2>&1 &`,
    'PLAY_PID=$!',
    `echo $PLAY_PID > ${shellQuote(logPath)}.pid`,
    'sleep 0.3',
    `${cap} 2>>${shellQuote(logPath)}`,
    'CAP_RC=$?',
    'kill $PLAY_PID 2>/dev/null',
    'wait $PLAY_PID 2>/dev/null',
    `echo "cap_rc=$CAP_RC"`,
    `ls -la ${shellQuote(captureRemote)} >>${shellQuote(logPath)} 2>&1`,
  ].join('\n');
}

async function probeTinyBinaries(target) {
  // Returns { tinyplay: bool, tinycap: bool, raw: string }. Caller fails fast
  // with the raw output if either is missing — Android `which` is in /system/bin.
  const r = await runAdbAllowFail(target,
    ['shell', 'for t in tinyplay tinycap; do if command -v $t >/dev/null 2>&1; then echo $t:yes; else echo $t:no; fi; done'],
    { timeoutMs: 10000 });
  const out = String(r.stdout || '');
  return {
    tinyplay: /tinyplay:yes/.test(out),
    tinycap: /tinycap:yes/.test(out),
    raw: out.trim(),
  };
}

// serial -> in-flight prepare Promise. Dedupes concurrent first-calls so
// two parallel resolveOnlineDevice() invocations don't both run `adb root`
// and race adbd's restart. Failures are removed so a retry is possible.
const adbPreparedDevices = new Map();

function prepareDevice(target) {
  const serial = target && target.adbDevice ? String(target.adbDevice).trim() : '';
  if (!serial) return Promise.resolve();
  let pending = adbPreparedDevices.get(serial);
  if (!pending) {
    pending = doPrepareDevice(target, serial).catch(err => {
      adbPreparedDevices.delete(serial);
      throw err;
    });
    adbPreparedDevices.set(serial, pending);
  }
  return pending;
}

async function doPrepareDevice(target, serial) {
  // Android needs `adb root` for ALSA PCM access and `setenforce 0` so SELinux
  // doesn't block tinyplay/tinycap or audio_aidl .so loading from SMB shares.
  // Linux-only boards (RV1103/RV1106/RK3308) don't have getprop/SELinux.
  const probe = await runAdbAllowFail(target,
    ['shell', 'if command -v getprop >/dev/null 2>&1; then getprop ro.build.type; fi'],
    { timeoutMs: 5000 });
  if (probe.code !== 0) {
    throw new Error(
      `adb probe failed on ${serial}: ${(probe.stderr || '').trim() || probe.code}`);
  }
  const isAndroid = (probe.stdout || '').trim().length > 0;
  if (!isAndroid) return;
  console.log(`prepareDevice[${serial}]: Android detected, requesting adb root`);
  const r = await runAdbAllowFail(target, ['root'], { timeoutMs: 5000 });
  if (r.code !== 0) {
    throw new Error(
      'adb root failed — device may be a user build without root. '
      + 'Root access is needed for ALSA PCM devices and SELinux. '
      + `(${(r.stderr || '').trim() || r.code})`
    );
  }
  // `adb root` kills and restarts adbd; wait for it to come back. Reconnection
  // time varies by board, so prefer wait-for-device over a fixed sleep.
  await runAdbAllowFail(target, ['wait-for-device'], { timeoutMs: 10000 });
  const se = await runAdbAllowFail(target, ['shell', 'setenforce 0'], { timeoutMs: 5000 });
  if (se.code !== 0) {
    console.warn(
      `prepareDevice[${serial}]: setenforce 0 failed — downstream tinyplay/tinycap `
      + `may be blocked by SELinux: ${(se.stderr || '').trim() || se.code}`);
  }
}

async function collectHardwareSignal(signalType, target, workspace, message) {
  // 1. Generate signal locally (skipped for silence — we want ambient noise).
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rockaa_hw_'));
  // Hardware acceptance rate is independent of device online rate — H-tests
  // threshold bands are calibrated at the rate the suite runs at. Default
  // 48 kHz (Android's standard HAL rate).
  const sampleRate = Number.isInteger(message.sampleRate) ? message.sampleRate : 48000;
  // Capture channel count is the codec's TDM width (e.g. ES7210 = 4 ch),
  // NOT numMic + numRef — the codec always fills N slots regardless of how
  // many mics are populated. The user sets this per board via the HW tab UI.
  const numChannels = Number.isInteger(message.captureChannels) && message.captureChannels > 0
    ? message.captureChannels
    : 2;
  const durationSec = Number(message.durationSec || 5);
  const playbackCard = Number.isInteger(message.playbackCard) ? message.playbackCard : 1;
  const captureCard = Number.isInteger(message.captureCard) ? message.captureCard : 1;
  const sessionId = autotuneSession.startedAt;
  let signalRemote = '';
  let captureRemote = '';
  let logRemote = '';
  try {
    const genTest = HW_SIGNAL_GEN_TEST[signalType];
    let signalLocal = '';
    let captureDurationSec = durationSec;
    if (genTest) {
      signalRemote = `${workspace}/signal_${signalType}.wav`;
      // Prefer bundled reference signals (correct sweep band + 10 s standard
      // duration). Fall back to gen-signal if no reference exists for this
      // sample rate / signal combination.
      const refName = HW_REFERENCE_FILES[sampleRate] && HW_REFERENCE_FILES[sampleRate][signalType];
      const refPath = refName ? path.join(HW_REFERENCE_DIR, String(sampleRate), refName) : null;
      if (refPath && fs.existsSync(refPath)) {
        signalLocal = refPath;
        // tinycap -T must cover the full playback so the whole sweep is
        // captured — read the actual file duration rather than using the
        // message default (5 s) which would truncate a 10 s sweep.
        const fileDur = readWavDurationSec(refPath);
        if (fileDur && fileDur > 0) captureDurationSec = Math.ceil(fileDur);
      } else {
        // gen-signal fallback for sample rates without a bundled reference
        // (8k/32k/44.1k). cmd_gen_signal only emits JSON when --output is
        // omitted; with --output it writes the WAV to disk and stays silent,
        // so we use the plain run() helper, not autotuneRunToCompletion.
        signalLocal = path.join(workDir, `signal_${signalType}.wav`);
        const genResult = await run(AUTOTUNE_PYTHON, [
          AUTOTUNE_CLI, 'gen-signal',
          '--test', genTest,
          '--sample-rate', String(sampleRate),
          '--duration', String(durationSec),
          '--output', signalLocal,
        ], { timeoutMs: 30000 });
        if (genResult.code !== 0 || !fs.existsSync(signalLocal)) {
          throw new Error(`gen-signal failed: ${(genResult.stderr || '').trim() || 'no output WAV'}`);
        }
      }
      await runAdb(target, ['push', signalLocal, signalRemote], { timeoutMs: 15000 });
    }

    // 2. Record on device. The shell command tees both stderr streams to a
    // logfile on the device so we can fetch and surface them on failure.
    captureRemote = `${workspace}/capture_${signalType}.wav`;
    logRemote = `${workspace}/hw_${signalType}.log`;
    autotuneBroadcast({
      type: 'autotune.hw.progress',
      sessionId,
      phase: 'collect',
      signal: signalType,
      status: 'recording',
    });
    const shellResult = await runAdb(target, ['shell',
      tinyplayTinycapShellCmd(signalRemote, captureRemote, sampleRate, numChannels, captureDurationSec, logRemote, playbackCard, captureCard),
    ], { timeoutMs: (captureDurationSec + 10) * 1000 });

    // 3. Pull capture + logfile back. Surface the device log so HAL errors
    // (e.g. "cannot open pcmC1D0c") aren't silently swallowed.
    const captureLocal = path.join(workDir, `capture_${signalType}.wav`);
    await runAdb(target, ['pull', captureRemote, captureLocal], { timeoutMs: 15000 });
    const logLocal = path.join(workDir, `hw_${signalType}.log`);
    const logPull = await runAdbAllowFail(target, ['pull', logRemote, logLocal], { timeoutMs: 5000 });
    let deviceLog = '';
    if (logPull && logPull.code === 0 && fs.existsSync(logLocal)) {
      deviceLog = fs.readFileSync(logLocal, 'utf8');
    }

    // 4. Read as base64 so the browser can cache it for the final run.
    const bytes = fs.readFileSync(captureLocal);
    const wavBase64 = bytes.toString('base64');
    // A correctly-recorded capture is ~sampleRate × numChannels × 2 × captureDurationSec;
    // if we see something tiny the device opened the file but captured almost
    // nothing (the classic HAL conflict). Surface the device log so the user
    // knows why rather than letting the H-tests silently all-FAIL on garbage.
    const expectedMinBytes = sampleRate * numChannels * 2 * captureDurationSec * 0.9;
    if (bytes.length < expectedMinBytes) {
      throw new Error(
        `capture too small for ${signalType}: ${bytes.length} bytes ` +
        `(expected ≥${Math.round(expectedMinBytes)}). ` +
        `device log:\n${deviceLog || '(empty)'}`
      );
    }
    autotuneBroadcast({
      type: 'autotune.hw.progress',
      sessionId,
      phase: 'collect',
      signal: signalType,
      status: 'done',
      durationSec: captureDurationSec,
      sizeBytes: bytes.length,
    });
    return { wavBase64, localPath: captureLocal };
  } finally {
    // Cleanup remote WAVs so device storage doesn't accumulate multi-MB files
    // across repeated auto-collect runs.
    if (signalRemote) {
      runAdbAllowFail(target, ['shell', `rm -f ${shellQuote(signalRemote)}`], { timeoutMs: 5000 }).catch(() => {});
    }
    if (captureRemote) {
      runAdbAllowFail(target, ['shell', `rm -f ${shellQuote(captureRemote)} ${shellQuote(logRemote)}`], { timeoutMs: 5000 }).catch(() => {});
    }
    fs.rm(workDir, { recursive: true, force: true }, () => {});
  }
}

async function runHardwareAcceptance(message) {
  // Five signals, each optional. whitenoise_sealed is import-only (the bridge
  // cannot seal the enclosure for the user). Others may be auto-collected or
  // imported — the browser sends whichever it has.
  if (autotuneBusy()) throw new Error(`autotune busy with ${autotuneSession.kind}`);
  autotuneSession.busy = true;
  const pre = await autotunePreflight();
  if (!pre.ok) throw new Error(pre.message);
  const target = await resolveOnlineDevice(message.target || {});
  const workspace = await selectOnlineWorkspace(target, target.deviceId);

  // Fail fast if tinyplay/tinycap are missing AND the user is trying to
  // auto-collect. Pure-import runs don't need them, but auto-collect does.
  const needAutoCollect = (message.autoCollect || []).filter(s => s && s !== 'whitenoise_sealed');
  if (needAutoCollect.length > 0) {
    const probe = await probeTinyBinaries(target);
    if (!probe.tinyplay || !probe.tinycap) {
      throw new Error(`device missing tinyplay/tinycap (${probe.raw}); use import mode`);
    }
  }

  autotuneSession.kind = 'hardware';
  autotuneSession.startedAt = Date.now();

  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rockaa_hw_run_'));
  // signalBase64 is keyed by signal type; whitenoise_sealed is browser-supplied.
  const signalBase64 = Object.assign({}, message.signalBase64 || {});
  try {
    // 1. Auto-collect any signals the browser asked us to capture.
    for (const sig of needAutoCollect) {
      if (signalBase64[sig]) continue;  // user already imported this one
      const r = await collectHardwareSignal(sig, target, workspace, message);
      signalBase64[sig] = r.wavBase64;
    }

    // 2. Write whatever signals we have to disk for the CLI.
    const paths = {};
    for (const sig of ['sweep', '1k', 'whitenoise', 'whitenoise_sealed', 'silence']) {
      const b64 = signalBase64[sig];
      if (!b64) continue;
      const p = path.join(workDir, `hw_${sig}.wav`);
      fs.writeFileSync(p, Buffer.from(b64, 'base64'));
      paths[sig] = p;
    }

    // 3. Spawn `autotune_cli.py hardware` and stream events back.
    const args = [
      AUTOTUNE_CLI, 'hardware',
      '--num-mic', String(message.numMic || 1),
      '--num-ref', String(message.numRef || 1),
      '--sample-rate', String(message.sampleRate || 48000),
      '--output-dir', workDir,
    ];
    if (paths.sweep) args.push('--hw-sweep', paths.sweep);
    if (paths['1k']) args.push('--hw-1k', paths['1k']);
    if (paths.whitenoise) args.push('--hw-whitenoise', paths.whitenoise);
    if (paths.whitenoise_sealed) args.push('--hw-whitenoise-sealed', paths.whitenoise_sealed);
    if (paths.silence) args.push('--hw-silence', paths.silence);
    if (message.nearField) args.push('--near-field');
    if (message.micSpacing) args.push('--mic-spacing', String(message.micSpacing));
    if (message.soundAngle) args.push('--sound-angle', String(message.soundAngle));

    return await autotuneRunToCompletion(args, { timeoutMs: 180000 });
  } finally {
    autotuneChildDied();
    fs.rm(workDir, { recursive: true, force: true }, () => {});
  }
}

const onlineSessions = new Map();
let shutdownTimer = null;
let shuttingDown = false;

function candidateAdbPaths() {
  const candidates = [];
  if (process.env.ROCKAA_ADB) candidates.push(process.env.ROCKAA_ADB);
  if (process.env.ADB) candidates.push(process.env.ADB);
  if (process.platform === 'win32') {
    candidates.push(path.join(DASHBOARD_ROOT, 'src', 'installs', 'built-windows', 'adb.exe'));
    candidates.push(path.join(DASHBOARD_ROOT, 'tools', 'codec-tool', 'build-windows', 'adb.exe'));
    candidates.push('adb.exe');
    candidates.push('adb');
  } else {
    candidates.push(path.join(process.env.ANDROID_HOME || '', 'platform-tools', 'adb'));
    candidates.push(path.join(process.env.ANDROID_SDK_ROOT || '', 'platform-tools', 'adb'));
    candidates.push('adb');
  }
  return candidates.filter(Boolean);
}

function findAdb() {
  for (const candidate of candidateAdbPaths()) {
    if (candidate.includes(path.sep) || path.isAbsolute(candidate)) {
      if (fs.existsSync(candidate)) return candidate;
      continue;
    }
    const result = childProcess.spawnSync(candidate, ['version'], {
      encoding: 'utf8',
      windowsHide: true,
    });
    if (!result.error && result.status === 0) return candidate;
  }
  return '';
}

function run(command, args, opts) {
  return new Promise((resolve, reject) => {
    const child = childProcess.spawn(command, args, {
      cwd: opts && opts.cwd ? opts.cwd : DASHBOARD_ROOT,
      env: process.env,
      shell: false,
      windowsHide: true,
    });
    const childSet = opts && opts.childSet;
    if (childSet) childSet.add(child);
    let stdout = '';
    let stderr = '';
    const limit = opts && opts.maxOutput ? opts.maxOutput : 1024 * 1024;
    const timeoutMs = opts && opts.timeoutMs ? opts.timeoutMs : 8000;
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`${path.basename(command)} timeout`));
    }, timeoutMs);

    child.stdout.on('data', chunk => {
      stdout += chunk.toString();
      if (stdout.length > limit) stdout = stdout.slice(stdout.length - limit);
    });
    child.stderr.on('data', chunk => {
      stderr += chunk.toString();
      if (stderr.length > limit) stderr = stderr.slice(stderr.length - limit);
    });
    child.on('error', err => {
      clearTimeout(timer);
      if (childSet) childSet.delete(child);
      reject(err);
    });
    child.on('close', code => {
      clearTimeout(timer);
      if (childSet) childSet.delete(child);
      if (code === 0) {
        resolve({ stdout, stderr, code });
        return;
      }
      reject(new Error((stderr || stdout || `${command} exited with ${code}`).trim()));
    });
  });
}

function openBrowser(urlText) {
  if (!OPEN_REQUESTED) return;
  const command = process.platform === 'win32'
    ? 'cmd'
    : process.platform === 'darwin' ? 'open' : 'xdg-open';
  const args = process.platform === 'win32'
    ? ['/c', 'start', '', urlText]
    : [urlText];
  const child = childProcess.spawn(command, args, {
    cwd: DASHBOARD_ROOT,
    env: process.env,
    shell: false,
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
  });
  child.unref();
}

function adbArgsForTarget(target, args) {
  const serial = target && target.adbDevice ? String(target.adbDevice).trim() : '';
  return serial ? ['-s', serial].concat(args) : args;
}

async function runAdb(target, args, opts) {
  const adb = findAdb();
  if (!adb) throw new Error('adb not found; set ROCKAA_ADB or add adb to PATH');
  const result = await run(adb, adbArgsForTarget(target, args), opts);
  return Object.assign({ adbPath: adb }, result);
}

async function runAdbAllowFail(target, args, opts) {
  try {
    return await runAdb(target, args, opts);
  } catch (err) {
    return { stdout: '', stderr: err.message, code: -1 };
  }
}

function shellQuote(text) {
  return `'${String(text).replace(/'/g, "'\\''")}'`;
}

function safeWorkspaceName(deviceId) {
  const serial = String(deviceId || 'unknown').trim() || 'unknown';
  return `_rockaa_dashboard_tuning_adb_${serial.replace(/[^0-9A-Za-z_.-]/g, '_')}_`;
}

async function selectOnlineWorkspace(target, deviceId, probeKiB = 1024,
                                     bases = ['/tmp', '/userdata', '/data/local/tmp']) {
  const name = safeWorkspaceName(deviceId);
  for (const base of bases) {
    const workspace = `${base}/${name}`;
    const command = [
      `b=${shellQuote(base)}`,
      `d=${shellQuote(workspace)}`,
      '[ -d "$b" ] || exit 1',
      'mkdir -p "$d" || exit 1',
      'probe="$d/.probe"',
      `dd if=/dev/zero of="$probe" bs=1024 count=${probeKiB} >/dev/null 2>&1`,
      'ok=$?',
      'rm -f "$probe"',
      'if [ "$ok" -eq 0 ]; then echo "$d"; else rmdir "$d" 2>/dev/null; exit 1; fi',
    ].join('; ');
    const result = await runAdbAllowFail(target, ['shell', command], { timeoutMs: 7000 });
    if (result.stdout.split(/\r?\n/).map(line => line.trim()).includes(workspace))
      return workspace;
  }
  throw new Error('no writable workspace under /tmp, /userdata or /data/local/tmp');
}

function cpuBitnessFromInfo(text) {
  const lower = String(text || '').toLowerCase();
  if (lower.includes('aarch64') || lower.includes('armv8') || /cpu\s+architecture\s*:\s*8/i.test(text))
    return '64-bit';
  if (lower.includes('armv7') || lower.includes('armv6') || /cpu\s+architecture\s*:\s*[67]/i.test(text))
    return '32-bit';
  return '';
}

function buildPlatformForBoardInfo(text) {
  const upper = String(text || '').toUpperCase();
  const bitness = cpuBitnessFromInfo(text);
  if (upper.includes('RV1103B_ARLO') || upper.includes('RV1103B'))
    return 'rv1103b';
  if (upper.includes('RV1106') || upper.includes('RV1103') || upper.includes('ROCKCHIP1106'))
    return 'rv1106';
  if (upper.includes('ROCKCHIP1240'))
    return 'rockchip1240';
  if (upper.includes('RK3588') || upper.includes('RK3568') || upper.includes('RK3576'))
    return 'arm64';
  if (upper.includes('RK3308') || upper.includes('RK3326'))
    return bitness === '32-bit' ? 'rk3308_32' : 'rk3308_64';
  if (upper.includes('RV1126B'))
    return 'rv1126b';
  if (upper.includes('RV1126') || upper.includes('RV1109'))
    return 'arm32';
  if (bitness === '64-bit') return 'arm64';
  if (bitness === '32-bit') return 'arm32';
  return '';
}

function platformsCategoryForBuildPlatform(buildPlatform) {
  if (buildPlatform === 'arm64' || buildPlatform === 'rk3308_64') return 'arm64';
  if (buildPlatform === 'arm32' || buildPlatform === 'rv1126b'
      || buildPlatform === 'rk3308_32') return 'arm32';
  if (buildPlatform === 'rv1106') return 'uclibc-830';
  if (buildPlatform === 'rv1103b' || buildPlatform === 'rv1103b_arlo') return 'uclibc-831';
  if (buildPlatform === 'rockchip1240' || buildPlatform === 'rockchip1240_uclibc') return 'uclibc-830';
  return '';
}

async function detectDevicePlatform(target) {
  const command = [
    'cat /proc/device-tree/model 2>/dev/null',
    'echo',
    'cat /sys/firmware/devicetree/base/model 2>/dev/null',
    'echo',
    'cat /proc/device-tree/compatible 2>/dev/null',
    'echo',
    'cat /sys/firmware/devicetree/base/compatible 2>/dev/null',
    'echo',
    'getprop ro.board.platform 2>/dev/null',
    'getprop ro.hardware 2>/dev/null',
    'getprop ro.product.board 2>/dev/null',
    'uname -m 2>/dev/null',
    'cat /proc/cpuinfo 2>/dev/null',
  ].join('; ');
  const result = await runAdb(target, ['shell', command], { timeoutMs: 10000, maxOutput: 256 * 1024 });
  const boardInfo = result.stdout + result.stderr;
  const buildPlatform = buildPlatformForBoardInfo(boardInfo);
  const category = platformsCategoryForBuildPlatform(buildPlatform);
  return {
    boardInfo,
    buildPlatform,
    category,
    soc: firstNonEmpty(boardInfo.split(/\r?\n/)) || buildPlatform || 'unknown',
  };
}

function platformsRootCandidates() {
  const preferred = process.platform === 'win32' ? 'built-windows' : 'built-linux';
  return [
    process.env.ROCKAA_PLATFORMS,
    path.join(DASHBOARD_ROOT, 'src', 'installs', preferred, 'platforms'),
    path.join(DASHBOARD_ROOT, 'src', 'installs', 'built-linux', 'platforms'),
    path.join(DASHBOARD_ROOT, 'src', 'installs', 'built-windows', 'platforms'),
    path.join(DASHBOARD_ROOT, 'src', 'installs', 'platforms'),
    path.join(process.cwd(), 'platforms'),
  ].filter(Boolean);
}

function findPlatformInstallDir(category) {
  for (const root of platformsRootCandidates()) {
    const dir = path.join(root, category);
    if (fs.existsSync(path.join(dir, 'utils', 'rockaa_capt'))
        && fs.existsSync(path.join(dir, 'utils', 'rockaa_play'))
        && fs.existsSync(path.join(dir, 'lib', 'librockaa.so'))) {
      return dir;
    }
  }
  return '';
}

function sedModelProfileForPlatform(platform) {
  const buildPlatform = platform && platform.buildPlatform;
  if (buildPlatform === 'rv1103b') return 'rv1103b';
  if (buildPlatform === 'rv1106') return 'rv1106_rv1103';
  if (buildPlatform === 'rv1126b') return 'rv1126b';
  return '';
}

function shouldUseBundledV2Runtime(channel, version, audioAidl) {
  return !audioAidl && String(channel).toUpperCase() === 'TX'
    && String(version || 'v1').toLowerCase() === 'v2';
}

function bundledSedModelForPlatform(platformDir, platform) {
  const profile = sedModelProfileForPlatform(platform);
  if (!profile) return null;
  const modelsDir = path.join(platformDir, 'sed', 'models');
  const manifestPath = path.join(modelsDir, 'manifest.json');
  if (!fs.existsSync(manifestPath)) return null;
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  const model = manifest.models && manifest.models[profile];
  if (!model || !Array.isArray(model.buildPlatforms)
      || !model.buildPlatforms.includes(platform.buildPlatform)) return null;
  const modelPath = path.join(modelsDir, String(model.file || ''));
  if (!fs.existsSync(modelPath)) return null;
  const bytes = fs.readFileSync(modelPath);
  const sha256 = crypto.createHash('sha256').update(bytes).digest('hex');
  if (!model.sha256 || sha256 !== String(model.sha256).toLowerCase())
    throw new Error(`SED model checksum mismatch: ${profile}`);
  return { file: modelPath, name: path.basename(modelPath), profile, sha256 };
}

function remoteVqeRuntimeCandidates(version, workspace) {
  const normalized = String(version || 'v1').toLowerCase();
  const dirs = [];
  if (workspace) dirs.push(`${workspace}/lib/${normalized === 'v2' ? 'vqe_v2' : 'vqe_v1'}`);
  if (normalized === 'v2') {
    dirs.push('/oem/usr/share/rockaa/vqe_v2', '/oem/usr/lib/vqe_v2', '/usr/lib/vqe_v2',
      '/oem/usr/lib', '/usr/lib', '/lib');
  } else {
    dirs.push('/oem/usr/share/rockaa/vqe_v1', '/oem/usr/lib/vqe_v1', '/usr/lib/vqe_v1',
      '/oem/usr/lib', '/usr/lib', '/lib');
  }
  return [...new Set(dirs)];
}

function safeConfigPath(relPath) {
  const rel = String(relPath || '').replace(/^[/\\]+/, '');
  if (!rel || rel.includes('\0')) return '';
  const full = path.resolve(HTML_ROOT, rel);
  if (!full.startsWith(HTML_ROOT + path.sep) && full !== HTML_ROOT) return '';
  return full;
}

function listJsonConfigs() {
  const results = [];
  const skipDirs = new Set(['node_modules', '.git', 'build', 'dist']);
  const walk = (dir, depth) => {
    if (depth > 3) return;
    let entries = [];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch (_) {
      return;
    }
    for (const entry of entries) {
      if (entry.name.startsWith('.')) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!skipDirs.has(entry.name)) walk(full, depth + 1);
        continue;
      }
      if (!entry.isFile() || !entry.name.toLowerCase().endsWith('.json')) continue;
      let text = '';
      try {
        text = fs.readFileSync(full, 'utf8');
      } catch (_) {
        continue;
      }
      if (!text.includes('skv_configs') && !text.includes('skv_ao_configs')) continue;
      const rel = path.relative(HTML_ROOT, full).replace(/\\/g, '/');
      results.push({ name: entry.name, path: rel });
    }
  };
  walk(HTML_ROOT, 0);
  results.sort((a, b) => a.path.localeCompare(b.path));
  return { root: HTML_ROOT, files: results };
}

function readJsonConfig(relPath) {
  const full = safeConfigPath(relPath);
  if (!full || !fs.existsSync(full) || !full.toLowerCase().endsWith('.json'))
    throw new Error('invalid config path');
  return {
    path: path.relative(HTML_ROOT, full).replace(/\\/g, '/'),
    name: path.basename(full),
    text: fs.readFileSync(full, 'utf8'),
  };
}

async function listDeviceConfigs(target) {
  const deviceId = String(target.adbDevice || '').trim();
  if (!deviceId || deviceId === 'no-adb-device')
    throw new Error('no ADB device selected');

  const runtimeWorkspaceName = safeWorkspaceName(deviceId);
  const findCommand = [
    'find /usr/share/rkaudio/ /etc/rkaudio/',
    '/oem/usr/share/rkaudio/',
    '/vendor/etc/',
    `/userdata/${runtimeWorkspaceName}/`,
    `/data/local/tmp/${runtimeWorkspaceName}/`,
    `/tmp/${runtimeWorkspaceName}/`,
    '/userdata/_rockaa_dashboard_tuning_online_/',
    '/userdata/_rockaa_dashboard_tuning_online_tx_/',
    '/userdata/_rockaa_dashboard_tuning_online_rx_/',
    '/data/local/tmp/_rockaa_dashboard_tuning_online_/',
    '/data/local/tmp/_rockaa_dashboard_tuning_online_tx_/',
    '/data/local/tmp/_rockaa_dashboard_tuning_online_rx_/',
    '/tmp/_rockaa_dashboard_tuning_online_/',
    '/tmp/_rockaa_dashboard_tuning_online_tx_/',
    '/tmp/_rockaa_dashboard_tuning_online_rx_/',
    "\\( -name 'config_aivqe*.json' -o -name 'config_aovqe*.json'",
    "-o -name 'rkaudio_effect_preprocess.json' \\) 2>/dev/null; true",
  ].join(' ');

  const result = await runAdbAllowFail(target, ['shell', findCommand], { timeoutMs: 5000 });
  const paths = [];
  for (const line of (result.stdout || '').split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const name = path.basename(trimmed);
    if (name.startsWith('config_') || name.startsWith('rkaudio_effect_'))
      paths.push(trimmed);
  }
  if (!paths.length)
    throw new Error('no config files found on device');
  return { paths: [...new Set(paths)] };
}

async function pullDeviceConfig(target, remotePath) {
  if (!remotePath || typeof remotePath !== 'string')
    throw new Error('remotePath is required');

  const tmpDir = os.tmpdir();
  const tmpName = `rockaa_device_config_${Date.now()}.json`;
  const tmpPath = path.join(tmpDir, tmpName);

  try {
    await runAdb(target, ['pull', remotePath, tmpPath], { timeoutMs: 10000 });
  } catch (err) {
    try { fs.unlinkSync(tmpPath); } catch (_) {}
    throw new Error(`failed to pull ${remotePath}: ${err.message}`);
  }

  let text = '';
  try {
    text = fs.readFileSync(tmpPath, 'utf8');
  } catch (err) {
    throw new Error(`failed to read pulled config: ${err.message}`);
  } finally {
    try { fs.unlinkSync(tmpPath); } catch (_) {}
  }

  if (!text.trim())
    throw new Error('pulled config is empty');

  const name = path.basename(remotePath);
  return { path: remotePath, name, text };
}

function safeEffectBinName(name) {
  const base = path.basename(String(name || '').trim());
  if (!base || base.includes('\0') || !base.toLowerCase().endsWith('.bin'))
    throw new Error('invalid effect bin name');
  return base.replace(/[^0-9A-Za-z_.-]/g, '_');
}

async function pushEffectBin(target, name, base64) {
  const binName = safeEffectBinName(name);
  if (!base64 || typeof base64 !== 'string')
    throw new Error('effect bin payload is required');
  const tmpPath = path.join(os.tmpdir(), `rockaa_effect_${process.pid}_${Date.now()}_${binName}`);
  const remotePath = `/vendor/etc/${binName}`;
  try {
    fs.writeFileSync(tmpPath, Buffer.from(base64, 'base64'));
    await runAdb(target, ['push', tmpPath, remotePath], { timeoutMs: 20000 });
    return { name: binName, remotePath };
  } finally {
    try { fs.unlinkSync(tmpPath); } catch (_) {}
  }
}

async function pullEffectBin(target, name) {
  const binName = safeEffectBinName(name);
  const tmpPath = path.join(os.tmpdir(), `rockaa_effect_pull_${process.pid}_${Date.now()}_${binName}`);
  const remotePath = `/vendor/etc/${binName}`;
  try {
    await runAdb(target, ['pull', remotePath, tmpPath], { timeoutMs: 20000 });
    const data = fs.readFileSync(tmpPath);
    return { name: binName, remotePath, base64: data.toString('base64') };
  } finally {
    try { fs.unlinkSync(tmpPath); } catch (_) {}
  }
}

async function findRemoteVqeRuntimeDir(target, candidates, requireCommon) {
  const quoted = candidates.filter(Boolean).map(shellQuote);
  if (!quoted.length) return '';
  const commonCheck = requireCommon ? ' && [ -r "$d/librkaudio_common.so" ]' : '';
  const command = `for d in ${quoted.join(' ')}; do `
    + `if [ -d "$d" ] && [ -r "$d/librkaudio_vqe.so" ]${commonCheck}; then echo "$d"; exit 0; fi; `
    + 'done; exit 1';
  const result = await runAdbAllowFail(target, ['shell', command], { timeoutMs: 5000 });
  return firstNonEmpty(result.stdout.split(/\r?\n/));
}

async function findMatchingRemoteVqeRuntimeDir(target, candidates, version, requireCommon) {
  for (const candidate of candidates) {
    const runtimeDir = await findRemoteVqeRuntimeDir(target, [candidate], requireCommon);
    if (!runtimeDir) continue;
    const detected = await detectRemoteVqeLibraryVersion(target, runtimeDir);
    if (detected.version === version) return runtimeDir;
  }
  return '';
}

async function detectRemoteVqeLibraryVersion(target, runtimeDir) {
  if (!runtimeDir) return { version: '', signature: '' };
  const pattern = 'Aec_Combine_BF|/aec_bf/|drop_ref_chan|array_reset|RKAibf_init|aibf|'
    + 'skv_para_dump_aec_config|parseSkvFastAecConfigs|dump_version|'
    + 'git-[0-9a-f]{7,}[^[:cntrl:]]*|Change-Id: I[0-9a-f]{40}';
  const command = `for f in ${shellQuote(`${runtimeDir}/librkaudio_vqe.so`)} ${shellQuote(`${runtimeDir}/librkaudio_common.so`)}; do `
    + 'if [ -r "$f" ]; then '
    + `if command -v strings >/dev/null 2>&1; then strings "$f" 2>/dev/null | grep -E ${shellQuote(pattern)}; `
    + `else grep -a -o -E ${shellQuote(pattern)} "$f" 2>/dev/null; fi; `
    + 'fi; done | head -120';
  const result = await runAdbAllowFail(target, ['shell', command], { timeoutMs: 8000 });
  const signature = String(result.stdout || '').trim();
  const lower = signature.toLowerCase();
  const gitVersion = (signature.match(/git-[0-9a-f]{7,}[^\r\n]*/i) || [''])[0].trim();
  const changeId = (signature.match(/Change-Id:\s*I[0-9a-f]{40}/i) || [''])[0].trim();
  if (lower.includes('/aec_bf/')
      || lower.includes('array_reset')
      || lower.includes('rkaibf_init')
      || /(^|\n)drop_ref_chan($|\n)/.test(lower)
      || /(^|\n)aibf($|\n)/.test(lower)) {
    return { version: 'v2', signature, gitVersion, changeId };
  }
  if (lower.includes('aec_combine_bf')
      || lower.includes('skv_para_dump_aec_config')
      || lower.includes('parseskvfastaecconfigs')
      || lower.includes('dump_version')) {
    return { version: 'v1', signature, gitVersion, changeId };
  }
  return { version: '', signature, gitVersion, changeId };
}

async function checkRemoteVqeVersion(message) {
  const requested = String(message.version || '').toLowerCase();
  if (!requested || requested === 'v_hci') return { ok: true, configVersion: requested };
  const target = await resolveOnlineDevice(message.target || {});
  const runtimeDir = await findMatchingRemoteVqeRuntimeDir(
    target,
    remoteVqeRuntimeCandidates(requested, ''),
    requested,
    requested === 'v2'
  );
  const detected = await detectRemoteVqeLibraryVersion(target, runtimeDir);
  if (!detected.version && target.adbDevice && await isAudioAidlDevice(target)) {
    // VQE is built into audio_aidl HAL — config version is inherently compatible.
    return {
      ok: true,
      configVersion: requested,
      libraryVersion: requested,
      runtimeDir: '(audio_aidl HAL)',
      signature: '',
      gitVersion: '',
      changeId: '',
      deviceId: target.adbDevice,
    };
  }
  return {
    ok: detected.version === requested,
    configVersion: requested,
    libraryVersion: detected.version,
    runtimeDir,
    signature: detected.signature,
    gitVersion: detected.gitVersion,
    changeId: detected.changeId,
    deviceId: target.adbDevice,
  };
}

function collectEnabledModelPaths(node, out) {
  if (!node || typeof node !== 'object') return;
  if (Array.isArray(node)) {
    for (const item of node) collectEnabledModelPaths(item, out);
    return;
  }
  // A module object carries both `status` and `model_path`; only enabled
  // modules actually load their model file on the device.
  if (typeof node.status === 'string'
      && node.status.toLowerCase() === 'enable'
      && typeof node.model_path === 'string'
      && node.model_path && node.model_path !== 'None') {
    out.push(node.model_path);
  }
  for (const key of Object.keys(node)) collectEnabledModelPaths(node[key], out);
}

async function checkOnlineModelFiles(target, config) {
  const required = [];
  collectEnabledModelPaths(config, required);
  if (!required.length) return [];
  const missing = [];
  for (const modelPath of [...new Set(required)]) {
    const result = await runAdbAllowFail(target,
      ['shell', `ls ${shellQuote(modelPath)} >/dev/null 2>&1; echo $?`],
      { timeoutMs: 5000 });
    if (String(result.stdout || '').trim() !== '0')
      missing.push(modelPath);
  }
  return missing;
}

async function runtimePrefixForDevice(target, workspace, configVersion) {
  const normalized = String(configVersion || 'v1').toLowerCase();
  const v1Dir = await findMatchingRemoteVqeRuntimeDir(
    target, remoteVqeRuntimeCandidates('v1', workspace), 'v1', false);
  const v2Dir = await findMatchingRemoteVqeRuntimeDir(
    target, remoteVqeRuntimeCandidates('v2', workspace), 'v2', true);
  const ldDirs = [`${workspace}/lib`];
  if (normalized === 'v2' && v2Dir) ldDirs.push(v2Dir);
  else if (v1Dir) ldDirs.push(v1Dir);
  let prefix = `export LD_LIBRARY_PATH=${ldDirs.map(shellQuote).join(':')}:$LD_LIBRARY_PATH; `
    + `export rockaa_vqe_version=${shellQuote(normalized)}; `;
  if (normalized === 'v1' && v1Dir)
    prefix += `export rockaa_vqe_v1_dir=${shellQuote(v1Dir)}; `;
  if (normalized === 'v2' && v2Dir)
    prefix += `export rockaa_vqe_v2_dir=${shellQuote(v2Dir)}; `;
  return { prefix, v1Dir, v2Dir, missingRequiredVqe: normalized === 'v2' ? !v2Dir : !v1Dir };
}

async function detectAudioHalType(target) {
  const result = await runAdbAllowFail(target, [
    'shell',
    "find /usr/lib /oem/usr/lib /lib -name 'libasound.so*' 2>/dev/null | head -1",
  ], { timeoutMs: 5000 });
  return result.stdout.includes('libasound.so') ? 'alsa' : 'tinyalsa';
}

function hostCaptureDevices() {
  const devices = ['default'];
  const result = childProcess.spawnSync('arecord', ['-L'], {
    encoding: 'utf8',
    windowsHide: true,
  });
  if (result.error || result.status !== 0) return devices;
  for (const line of String(result.stdout || '').split(/\r?\n/)) {
    if (!line || /^\s/.test(line)) continue;
    const device = line.trim();
    if (!device || device === 'null' || devices.includes(device)) continue;
    devices.push(device);
  }
  return devices;
}

function parseAdbDevices(text) {
  return text.split(/\r?\n/)
    .slice(1)
    .map(line => line.trim())
    .filter(Boolean)
    .map(line => {
      const parts = line.split(/\s+/);
      return {
        id: parts[0] || '',
        serial: parts[0] || '',
        state: parts[1] || '',
        detail: parts.slice(2).join(' '),
      };
    });
}

async function adbDevices() {
  const result = await runAdb(null, ['devices', '-l']);
  return {
    devices: parseAdbDevices(result.stdout),
    adbPath: result.adbPath,
    platform: process.platform,
  };
}

// Tracks adb device list changes and pushes `adb.devices-changed` to all ws
// clients. Polls at 1s — `adb devices` is ~50ms locally, so setInterval is
// cheap. Covers the "browser opened before device" race that refreshBridgeStatus
// on the frontend can't (it only fires on bridge connect / explicit refresh).
let adbTrackerTimer = null;
let adbTrackerInFlight = false;
let lastDeviceSnapshot = null;

function deviceSnapshot(devices) {
  return devices.map(d => `${d.id || ''}|${d.state || ''}`).sort().join('\n');
}

async function pollAdbDevices() {
  if (adbTrackerInFlight) return;
  adbTrackerInFlight = true;
  let current;
  try {
    current = (await adbDevices()).devices;
  } catch (_) {
    return;
  } finally {
    adbTrackerInFlight = false;
  }
  const snap = deviceSnapshot(current);
  if (lastDeviceSnapshot === null) {
    lastDeviceSnapshot = snap;
    return;
  }
  if (snap === lastDeviceSnapshot) return;
  lastDeviceSnapshot = snap;
  const body = { type: 'adb.devices-changed', devices: current };
  for (const client of clients) sendJson(client, body);
}

function startAdbDeviceTracker() {
  if (adbTrackerTimer) return;
  adbTrackerTimer = setInterval(pollAdbDevices, 1000);
}

function firstNonEmpty(lines) {
  return lines.map(line => line.trim()).find(Boolean) || '';
}

async function detectDeviceAudioInfo(target) {
  // Single shell script with newlines — Android mksh rejects 'do; if' joined by semicolons.
  const command = [
    'echo "=== HW_PARAMS ==="',
    'for f in /proc/asound/card*/pcm*c/sub0/hw_params',
    'do',
    '  if [ -f "$f" ]',
    '  then',
    '    txt=$(cat "$f" 2>/dev/null)',
    '    case "$txt" in',
    '      *channels:*) echo "path=$f" && echo "$txt" && break ;;',
    '    esac',
    '  fi',
    'done',
    'echo "=== ASOUND_CONF ==="',
    'cat /etc/asound.conf 2>/dev/null',
    'echo "=== CONFIG_JSONS ==="',
    'cat /vendor/etc/rkaudio_effect_preprocess.json'
      + ' /oem/usr/share/vqefiles/config_aivqe.json'
      + ' /usr/share/vqefiles/config_aivqe.json'
      + ' /usr/share/rkaudio/config_aivqe_new.json'
      + ' /etc/vqefiles/config_aivqe.json 2>/dev/null',
  ].join('\n') + '\ntrue\n';

  const result = await runAdbAllowFail(target, ['shell', command], { timeoutMs: 5000 });
  const output = result.stdout || '';

  // Parse ALSA hw_params
  let sampleRate = SAMPLE_RATE;
  let totalChannels = 0;
  const hwMatch = output.match(/channels:\s*(\d+)/);
  if (hwMatch) totalChannels = parseInt(hwMatch[1], 10) || 0;
  const rateMatch = output.match(/rate:\s*(\d+)/);
  if (rateMatch) sampleRate = parseInt(rateMatch[1], 10) || SAMPLE_RATE;

  // Parse ref_channels from asound.conf, or ref_pos from config JSON
  let refChannels = 0;
  const refMatch = output.match(/ref_channels\s+(\d+)/);
  if (refMatch) refChannels = parseInt(refMatch[1], 10) || 0;

  // Parse bf.num_channel from config JSONs — bf.num_channel = mic channels only (Qt semantics).
  // refChannels is derived: totalChannels - bfNum (from ALSA) or from asound.conf.
  let micChannels = 1;
  const jsonBlock = output.match(/\{[\s\S]*"skv_configs"[\s\S]*?"bf"[\s\S]*?"num_channel"[\s\S]*?\}/);
  if (jsonBlock) {
    const bfMatch = jsonBlock[0].match(/"num_channel"\s*:\s*(\d+)/);
    if (bfMatch) {
      const bfNum = parseInt(bfMatch[1], 10);
      if (bfNum > 0) micChannels = bfNum;
    }
  } else {
    // Fallback: simpler regex on chunks
    const configJsons = (output.match(/\{[^{}]*"skv_configs"[^{}]*"bf"[^{}]*"num_channel"[^{}]*\}/g) || [])
      .concat(output.match(/\{[^{}]*"skv_configs"[\s\S]*?"bf"[\s\S]*?"num_channel"[\s\S]*?\}/g) || []);
    for (const chunk of configJsons) {
      const bfMatch = chunk.match(/"num_channel"\s*:\s*(\d+)/);
      if (bfMatch) {
        const bfNum = parseInt(bfMatch[1], 10);
        if (bfNum > 0) { micChannels = bfNum; break; }
      }
    }
  }

  // Derive refChannels: Qt logic — if totalChannels > bfNum, extras are refs.
  // If no ALSA info but asound.conf had ref_channels, keep that.
  if (totalChannels > micChannels) {
    if (!refMatch) refChannels = totalChannels - micChannels;
    // else keep asound.conf value
  } else if (totalChannels > 0 && !refMatch) {
    refChannels = 0;
  }

  return { sampleRate, totalChannels, refChannels, micChannels };
}

async function connectDevice(target) {
  const mode = target && target.mode ? target.mode : 'adb';
  if (mode === 'net') {
    const host = target && target.host ? String(target.host).trim() : '';
    const port = target && target.port ? String(target.port).trim() : '5555';
    if (!host) throw new Error('network target host is empty');
    await runAdb(null, ['connect', `${host}:${port}`], { timeoutMs: 15000 });
  } else if (mode === 'serial') {
    throw new Error('serial transport is not implemented by the ADB bridge');
  }

  const devices = await adbDevices();
  let deviceId = target && target.adbDevice ? String(target.adbDevice).trim() : '';
  if (!deviceId) {
    const ready = devices.devices.find(device => device.state === 'device');
    deviceId = ready ? ready.id : '';
  }
  if (!deviceId) throw new Error('no online adb device');

  const deviceTarget = Object.assign({}, target, { adbDevice: deviceId });
  const platform = await detectDevicePlatform(deviceTarget);
  let audioInfo = { sampleRate: SAMPLE_RATE, totalChannels: 0, refChannels: 0, micChannels: 1 };
  try {
    audioInfo = await detectDeviceAudioInfo(deviceTarget);
  } catch (err) {
    console.error(`audio info detection failed: ${err.message || err}`);
  }
  return {
    adbDevice: deviceId,
    soc: platform.soc,
    buildPlatform: platform.buildPlatform,
    category: platform.category,
    sampleRate: audioInfo.sampleRate,
    channels: `${audioInfo.micChannels}+${audioInfo.refChannels}`,
    micChannels: audioInfo.micChannels,
    refChannels: audioInfo.refChannels,
    totalChannels: audioInfo.totalChannels,
    latencyMs: null,
    adbPath: findAdb(),
    platform: process.platform,
  };
}

async function disconnectDevice(target) {
  if (target && target.mode === 'net' && target.host) {
    const port = target.port || '5555';
    await runAdb(null, ['disconnect', `${target.host}:${port}`], { timeoutMs: 10000 });
  }
  return { disconnected: true };
}

function cancelScheduledShutdown() {
  if (!shutdownTimer) return;
  clearTimeout(shutdownTimer);
  shutdownTimer = null;
}

function scheduleShutdown(reason, delayMs) {
  if (shutdownTimer || shuttingDown) return;
  shutdownTimer = setTimeout(() => {
    shutdownTimer = null;
    shutdown(reason).catch(err => {
      console.error(`shutdown failed: ${err.message || err}`);
      process.exit(1);
    });
  }, delayMs || 1200);
}

function onlineLocalStreamPorts(deviceId, channel) {
  const digest = crypto.createHash('sha1').update(String(deviceId || '')).digest();
  const value = digest.readUInt32LE(0);
  const channelOffset = String(channel).toUpperCase() === 'RX' ? 3 : 0;
  const basePort = 20000 + (value % 7000) * 6 + channelOffset;
  return { in: basePort, out: basePort + 1, source: basePort + 2 };
}

function onlineRemotePorts(channel) {
  return String(channel).toUpperCase() === 'RX'
    ? { in: 19110, out: 19111, source: 19112 }
    : { in: 19100, out: 19101, source: 19102 };
}

function onlineRemoteProgram(channel) {
  return String(channel).toUpperCase() === 'RX' ? 'rockaa_play' : 'rockaa_capt';
}

function configRootForChannel(channel) {
  return String(channel).toUpperCase() === 'RX' ? 'skv_ao_configs' : 'skv_configs';
}

function numberFromConfig(value, fallback) {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string') {
    const n = Number(value.replace(/^float:/, ''));
    if (Number.isFinite(n)) return n;
  }
  return fallback;
}

function positiveInt(value, fallback, min) {
  const n = Number(value);
  const lower = min == null ? 1 : min;
  if (!Number.isFinite(n)) return fallback;
  return Math.max(lower, Math.min(32, Math.floor(n)));
}

function sourceByteLength(value) {
  const bytes = Number(value);
  if (!Number.isSafeInteger(bytes) || bytes < 1 || bytes > MAX_RX_SOURCE_BYTES)
    return 0;
  return bytes;
}

function normalizeOnlineChannelConfig(channel, config) {
  const rx = String(channel).toUpperCase() === 'RX';
  if (rx) {
    const inputChannels = positiveInt(config && config.inputChannels, 2);
    return {
      inputChannels,
      micChannels: inputChannels,
      refChannels: 1,
      outputChannels: positiveInt(config && config.outputChannels, inputChannels),
    };
  }
  const micChannels = positiveInt(config && config.micChannels, 1);
  const refChannels = positiveInt(config && config.refChannels, 1);
  return {
    inputChannels: micChannels + refChannels,
    micChannels,
    refChannels,
    outputChannels: positiveInt(config && config.outputChannels, 1),
  };
}

function onlineChannelConfig(channel, config, override) {
  if (override && typeof override === 'object')
    return normalizeOnlineChannelConfig(channel, override);

  const root = config && config[configRootForChannel(channel)];
  if (String(channel).toUpperCase() === 'RX') {
    const rx = root && root.rx;
    return normalizeOnlineChannelConfig(channel, {
      inputChannels: Math.max(1, numberFromConfig(rx && rx.input_channels, 2)),
      outputChannels: 1,
    });
  }
  const bf = root && root.bf;
  return normalizeOnlineChannelConfig(channel, {
    micChannels: Math.max(1, numberFromConfig(bf && bf.num_channel, 1)),
    refChannels: Math.max(1, numberFromConfig(root && root.ref_channels, 1)),
    outputChannels: 1,
  });
}

function localConfigFile(channel, config) {
  const name = String(channel).toUpperCase() === 'RX' ? 'config_aovqe.json' : 'config_aivqe.json';
  const file = path.join(os.tmpdir(), `rockaa_html_${process.pid}_${Date.now()}_${name}`);
  fs.writeFileSync(file, JSON.stringify(config, null, 2));
  return { file, name };
}

function buildOnlineRunCommand(options) {
  const channel = String(options.channel).toUpperCase();
  const streamPortEnv = `export rockaa_vqe_stream_in_port=${options.remotePorts.in}; `
    + `export rockaa_vqe_stream_out_port=${options.remotePorts.out}; `;
  // A stale interval file from a previous run would override the env
  // seed, so clear it before every launch; live changes rewrite it.
  // When stats are switched off in the panel, pre-write "off" so the
  // sampler pauses right after coming up.
  const perfIntervalEnv =
    `rm -f ${PERF_INTERVAL_FILE}; `
    + `export rockaa_perf_interval=${clampPerfIntervalSeconds(options.perfInterval)}; `
    + (options.perfEnabled === false ? `echo off > ${PERF_INTERVAL_FILE}; ` : '');
  const sedModelEnv = options.sedModelRemotePath
    ? `export rockaa_sed_rknn_path=${shellQuote(options.sedModelRemotePath)}; `
    : '';
  if (channel === 'RX') {
    const inputArg = options.rxSourceRemotePath || '/dev/zero';
    if (options.rxSourceRemotePath && (options.rxHostRecordSource || options.rxPlaybackOn)) {
      return `cd ${shellQuote(options.workspace)} && `
        + options.runtimePrefix
        + perfIntervalEnv
        + 'export rockaa_stream_wait_client_ms=5000; '
        + 'export rockaa_vqe_inout_stream_only=true; '
        + 'export rockaa_vqe_inout_stream_blocking=true; '
        + streamPortEnv
        + `export rockaa_ao_vqe_inout=true@${shellQuote(options.workspace)}; `
        + `./utils/rockaa_play ${shellQuote(inputArg)} --hal ${shellQuote(options.audioHalType)} `
        + `-c ${options.channelConfig.inputChannels} -r ${SAMPLE_RATE} -b ${BITS} `
        + `-p ${NB_SAMPLES} -Z 1 --perf -F ${shellQuote(options.confName)}`;
    }
    return `cd ${shellQuote(options.workspace)} && `
      + options.runtimePrefix
      + perfIntervalEnv
      + 'export rockaa_stream_wait_client_ms=5000; '
      + 'export rockaa_vqe_inout_stream_only=true; '
      + 'export rockaa_vqe_inout_stream_blocking=true; '
      + streamPortEnv
      + `export rockaa_ao_vqe_inout=true@${shellQuote(options.workspace)}; `
      + `./utils/rockaa_play -I ${shellQuote(inputArg)} -O /dev/null `
      + `-c ${options.channelConfig.inputChannels} -r ${SAMPLE_RATE} -b ${BITS} `
      + `-p ${NB_SAMPLES} -Z 1 --perf -F ${shellQuote(options.confName)}`;
  }
  return `cd ${shellQuote(options.workspace)} && `
    + options.runtimePrefix
    + perfIntervalEnv
    + sedModelEnv
    + 'export rockaa_vqe_inout_stream_only=true; '
    + 'export rockaa_vqe_inout_stream_blocking=true; '
    + streamPortEnv
    + `export rockaa_ai_vqe_inout=true@${shellQuote(options.workspace)}; `
    + `./utils/rockaa_capt /dev/null --hal ${shellQuote(options.audioHalType)} `
    + `-c ${options.channelConfig.inputChannels} -C ${Math.max(1, options.channelConfig.refChannels)} `
    + `-b ${BITS} -r ${SAMPLE_RATE} -p ${NB_SAMPLES} `
    + `-Z 1 --perf -F ${shellQuote(options.confName)} -O /dev/null`;
}

function broadcastOnlineLog(channel, message, skipClients) {
  const liveBody = { type: 'online.log', channel, message };
  const skip = skipClients || new Set();
  for (const client of clients) {
    if (!skip.has(client)) sendJson(client, liveBody);
  }
}

function broadcastOnlinePerf(channel, perf) {
  const body = { type: 'online.perf', channel, perf };
  for (const client of clients) sendJson(client, body);
}

// rockaa_perf.c prints single-line records like
//   ROCKAA_PERF {"cpu":25.0,"cpu_avg":24.9,...,"final":0}
// Extract and parse the JSON payload; return null for other lines.
function parseRockaaPerfLine(text) {
  if (!text || text.indexOf('ROCKAA_PERF') < 0) return null;
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  try {
    return JSON.parse(text.slice(start, end + 1));
  } catch (_) {
    return null;
  }
}

function attachOnlineProcessOutput(session, child) {
  const attach = (stream, checkRxSource) => {
    let pending = '';
    stream.on('data', chunk => {
      const text = chunk.toString();
      sendSessionLog(session, text.trim());
      if (checkRxSource && text.includes('waiting for RX source stream'))
        connectRxSource(session);

      pending += text;
      const lines = pending.split(/\r?\n/);
      pending = lines.pop() || '';
      for (const line of lines) {
        const perf = parseRockaaPerfLine(line);
        if (perf) broadcastOnlinePerf(session.channel, perf);
      }
    });
    stream.on('end', () => {
      const perf = parseRockaaPerfLine(pending);
      if (perf) broadcastOnlinePerf(session.channel, perf);
    });
  };
  attach(child.stdout, true);
  attach(child.stderr, false);
}

// Sample interval for rockaa_perf.c: default 3s, clamped to [1,10]s.
// Live changes go through PERF_INTERVAL_FILE, re-read by the board
// sampler every poll slice.
function clampPerfIntervalSeconds(value) {
  const n = parseInt(value, 10);
  if (!Number.isFinite(n)) return 3;
  return Math.min(10, Math.max(1, n));
}

// Write a control value (interval seconds or "off") to the file the
// board-side sampler polls, for every running online simulation. A
// failed adb write is reported per channel so the UI can tell an
// applied change from a silent one.
async function pushPerfControl(content, okMessage) {
  const channels = [];
  const failed = [];
  for (const session of onlineSessions.values()) {
    if (session.audioAidl || !session.adbTarget)
      continue;
    const target = session.adbTarget;
    const res = await runAdbAllowFail(target, ['shell',
      `echo ${content} > ${PERF_INTERVAL_FILE}`], { timeoutMs: 5000 });
    if (res && res.code === 0) {
      sendSessionLog(session, okMessage);
      channels.push(session.channel);
    } else {
      const reason = (res && res.stderr) || `adb exit ${res && res.code}`;
      sendSessionLog(session,
        `Perf sampling control NOT applied (${reason})`);
      failed.push(session.channel);
    }
  }
  return { channels, failed };
}

// Re-pace running simulations: the clamped seconds also resume a
// paused sampler; sessions launched later pick the value up through
// the env seed on start.
async function setOnlinePerfInterval(message) {
  const seconds = clampPerfIntervalSeconds(message.value);
  const { channels, failed } = await pushPerfControl(
    seconds, `Perf sampling interval set to ${seconds}s`);
  return { seconds, channels, failed };
}

// Mute or unmute the board-side sampler: "off" stops the records and
// clears the accumulated statistics, an integer resumes them.
async function setOnlinePerfToggle(message) {
  const enabled = message.enabled !== false;
  const seconds = clampPerfIntervalSeconds(message.interval);
  const { channels, failed } = enabled
    ? await pushPerfControl(seconds, `Perf sampling resumed at ${seconds}s`)
    : await pushPerfControl('off', 'Perf sampling paused');
  return { enabled, seconds, channels, failed };
}

function sendSessionLog(session, message) {
  const body = { type: 'log', message };
  if (session.history) {
    session.history.push(body);
    if (session.history.length > 200) session.history.shift();
  }
  for (const client of session.clients) sendJson(client, body);
  broadcastOnlineLog(session.channel, message, session.clients);
}

function pcm16MonoToStereo(buffer, channels) {
  // Convert N-channel host capture to 2ch mono-stereo: mix to mono then
  // duplicate to L/R so the device sound card produces a loopback reference
  // regardless of which channel it reads from.
  const srcChannels = Math.max(1, channels || 1);
  const frameBytes = srcChannels * 2;
  const frames = Math.floor(buffer.length / frameBytes);
  const stereo = Buffer.alloc(frames * 4);
  for (let frame = 0; frame < frames; frame++) {
    let sum = 0;
    for (let ch = 0; ch < srcChannels; ch++)
      sum += buffer.readInt16LE(frame * frameBytes + ch * 2);
    const mono = Math.max(-32768, Math.min(32767, Math.round(sum / srcChannels)));
    stereo.writeInt16LE(mono, frame * 4);
    stereo.writeInt16LE(mono, frame * 4 + 2);
  }
  return stereo;
}

function floatSamplesFromPcm16(buffer) {
  const samples = new Array(Math.floor(buffer.length / 2));
  for (let i = 0; i < samples.length; i++)
    samples[i] = buffer.readInt16LE(i * 2) / 32768;
  return samples;
}

function normalizeHostPlayback(playback) {
  if (!playback || typeof playback !== 'object')
    return { stream: '', channel: 0 };
  const stream = String(playback.stream || '').toLowerCase();
  const channel = Number(playback.channel);
  if ((stream !== 'input' && stream !== 'output') || !Number.isInteger(channel) || channel < 0)
    return { stream: '', channel: 0 };
  return { stream, channel };
}

function pcm16Channel(buffer, channels, channelIndex) {
  const srcChannels = Math.max(1, channels || 1);
  if (channelIndex < 0 || channelIndex >= srcChannels)
    return Buffer.alloc(0);
  const frameBytes = srcChannels * 2;
  const frames = Math.floor(buffer.length / frameBytes);
  const mono = Buffer.alloc(frames * 2);
  for (let frame = 0; frame < frames; frame++) {
    buffer.copy(mono, frame * 2,
      frame * frameBytes + channelIndex * 2,
      frame * frameBytes + channelIndex * 2 + 2);
  }
  return mono;
}

function stopHostPlayback(session) {
  if (!session || !session.hostPlaybackProcess) return;
  const child = session.hostPlaybackProcess;
  session.hostPlaybackProcess = null;
  try { child.stdin.end(); } catch (_) {}
  try { child.kill(); } catch (_) {}
}

function startHostPlayback(session, sampleRate) {
  if (!session) return null;
  const rate = Math.max(1, sampleRate || SAMPLE_RATE);
  if (session.hostPlaybackProcess && session.hostPlaybackSampleRate === rate)
    return session.hostPlaybackProcess;
  stopHostPlayback(session);

  if (process.platform === 'win32') {
    if (!session.hostPlaybackWarned) {
      session.hostPlaybackWarned = true;
      sendSessionLog(session, 'host playback is only implemented on Linux hosts');
    }
    return null;
  }

  const child = childProcess.spawn('aplay',
    ['-q', '-D', 'default', '-t', 'raw', '-f', 'S16_LE', '-r', String(rate), '-c', '1'], {
      cwd: DASHBOARD_ROOT,
      env: process.env,
      stdio: ['pipe', 'ignore', 'pipe'],
      shell: false,
      windowsHide: true,
    });
  session.hostPlaybackProcess = child;
  session.hostPlaybackSampleRate = rate;
  session.hostPlaybackWarned = false;
  sendSessionLog(session, `host playback started: default ${rate}Hz mono`);
  child.stderr.on('data', chunk => {
    const text = chunk.toString().trim();
    if (text) sendSessionLog(session, `host playback: ${text}`);
  });
  child.on('error', err => {
    if (!session.hostPlaybackWarned) {
      session.hostPlaybackWarned = true;
      sendSessionLog(session, `host playback failed: ${err.message}`);
    }
  });
  child.on('close', code => {
    if (session.hostPlaybackProcess === child)
      session.hostPlaybackProcess = null;
    if (code !== 0 && !session.hostPlaybackWarned) {
      session.hostPlaybackWarned = true;
      sendSessionLog(session, `host playback exited: ${code}`);
    }
  });
  return child;
}

function feedHostPlayback(session, kind, payload, channels, sampleRate) {
  const playback = session && session.hostPlayback;
  if (!playback || playback.stream !== kind)
    return;
  if (playback.channel >= Math.max(1, channels || 1))
    return;
  const child = startHostPlayback(session, sampleRate);
  if (!child || !child.stdin || child.stdin.destroyed)
    return;
  if (child.stdin.writableLength > Math.max(4096, (sampleRate || SAMPLE_RATE) * 2))
    return;
  const mono = pcm16Channel(payload, channels, playback.channel);
  if (mono.length)
    child.stdin.write(mono);
}

class PcmStreamParser {
  constructor(session, kind, fallbackChannels) {
    this.session = session;
    this.kind = kind;
    this.fallbackChannels = fallbackChannels;
    this.channels = fallbackChannels;
    this.sampleRate = SAMPLE_RATE;
    this.frameSize = NB_SAMPLES;
    this.headerRead = false;
    this.buffer = Buffer.alloc(0);
  }

  feed(chunk) {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    if (!this.headerRead) {
      if (this.buffer.length < STREAM_HEADER_SIZE) return;
      const header = this.buffer.subarray(0, STREAM_HEADER_SIZE);
      if (header.readUInt32LE(0) === 0x524B4155) {
        const sampleRate = header.readUInt16LE(6);
        const channels = header.readUInt16LE(8);
        const bits = header.readUInt16LE(10);
        const frameSize = header.readUInt16LE(12);
        this.channels = channels || this.fallbackChannels;
        this.sampleRate = sampleRate || SAMPLE_RATE;
        this.frameSize = frameSize || NB_SAMPLES;
        this.buffer = this.buffer.subarray(STREAM_HEADER_SIZE);
        sendSessionLog(this.session,
          `${this.kind} stream header: ${this.channels}ch ${this.sampleRate}Hz ${bits}bit frame=${this.frameSize}`);
      }
      this.headerRead = true;
    }

    const frameBytes = this.frameSize * Math.max(1, this.channels) * 2;
    const completeBytes = Math.floor(this.buffer.length / frameBytes) * frameBytes;
    if (!completeBytes) return;
    const payload = this.buffer.subarray(0, completeBytes);
    this.buffer = this.buffer.subarray(completeBytes);
    if (this.session.receivedStreams) this.session.receivedStreams.add(this.kind);
    feedHostPlayback(this.session, this.kind, payload, this.channels, this.sampleRate);
    const samples = floatSamplesFromPcm16(payload);
    const body = {
      type: this.kind,
      data: samples,
      channels: this.channels,
      sampleRate: this.sampleRate,
    };
    for (const client of this.session.clients) sendJson(client, body);
  }
}

async function stopOnlineSession(channel) {
  const key = String(channel || '').toUpperCase();
  const session = onlineSessions.get(key);
  if (!session) return { stopped: false };
  onlineSessions.delete(key);
  if (session.sourceTimer) clearTimeout(session.sourceTimer);
  if (session.sourceConnectTimer) clearTimeout(session.sourceConnectTimer);
  if (session.hostRecordProcess) session.hostRecordProcess.kill();
  stopHostPlayback(session);
  if (session.sourceSocket) session.sourceSocket.destroy();
  for (const socket of session.sockets) socket.destroy();
  if (session.process) session.process.kill();
  for (const client of session.clients)
    sendJson(client, { type: 'log', message: 'online session stopped' });
  const target = { adbDevice: session.deviceId };
  await Promise.all([
    runAdbAllowFail(target, ['forward', '--remove', `tcp:${session.localPorts.in}`], { timeoutMs: 1000 }),
    runAdbAllowFail(target, ['forward', '--remove', `tcp:${session.localPorts.out}`], { timeoutMs: 1000 }),
    runAdbAllowFail(target, ['forward', '--remove', `tcp:${session.localPorts.source}`], { timeoutMs: 1000 }),
    runAdbAllowFail(target, ['shell',
      `pkill -INT ${onlineRemoteProgram(key)} 2>/dev/null || killall -INT ${onlineRemoteProgram(key)} 2>/dev/null || true`],
    { timeoutMs: 2000 }),
  ]);
  return { stopped: true };
}

function connectForwardedStream(session, kind, port, fallbackChannels) {
  const generation = session.streamGeneration || 0;
  const active = () => onlineSessions.get(session.channel) === session
    && (session.streamGeneration || 0) === generation;
  let attempts = 0;
  let hadConnection = false;
  const connect = () => {
    if (!active()) return;
    const socket = net.createConnection({ host: '127.0.0.1', port });
    const parser = new PcmStreamParser(session, kind, fallbackChannels);
    let received = false;
    let lastError = '';
    session.sockets.add(socket);
    socket.on('connect', () => {
      if (!active()) { socket.destroy(); return; }
      session.connectedStreams.add(kind);
      if (!hadConnection) {
        hadConnection = true;
        sendSessionLog(session, `${kind} stream connected: 127.0.0.1:${port}`);
      }
      maybeStartRxSource(session);
    });
    socket.on('data', chunk => {
      if (!active()) return;
      received = true;
      parser.feed(chunk);
    });
    socket.on('error', err => {
      lastError = err.message;
    });
    socket.on('close', () => {
      session.sockets.delete(socket);
      if (!active()) return;
      session.connectedStreams.delete(kind);
      if (received) {
        setTimeout(connect, 1000);
        return;
      }
      if (++attempts <= 300) {
        if (attempts === 1 || attempts % 30 === 0) {
          const reason = lastError || 'closed before PCM';
          if (session.audioAidl)
            sendSessionLog(session, `${kind} stream waiting for HAL (attempt ${attempts}): ${reason}`);
          else
            sendSessionLog(session, `${kind} stream retry: ${reason}`);
        }
        setTimeout(connect, 100);
      } else {
        sendSessionLog(session, `${kind} stream failed: ${lastError || 'closed before PCM'}`);
      }
    });
  };
  connect();
}

function normalizeRxSource(message, channelConfig) {
  const source = message && message.rxSource && typeof message.rxSource === 'object'
    ? message.rxSource : {};
  const mode = String(source.mode || 'none');
  if (mode === 'file') {
    const buffer = Buffer.from(String(source.base64 || ''), 'base64');
    if (!buffer.length) throw new Error('RX source file is empty');
    if (buffer.length > MAX_RX_SOURCE_BYTES)
      throw new Error('RX source file is too large');
    return {
      mode,
      buffer,
      fileName: String(source.fileName || 'rx_source.pcm'),
      channels: positiveInt(source.channels, channelConfig.inputChannels),
      sampleRate: positiveInt(source.sampleRate, SAMPLE_RATE),
      playbackOn: source.playbackOn === true,
    };
  }
  if (mode === 'browser-file') {
    const bytes = sourceByteLength(source.bytes);
    if (!bytes) throw new Error('RX source file is empty or too large');
    return {
      mode,
      fileName: String(source.fileName || 'rx_source.pcm'),
      channels: positiveInt(source.channels, channelConfig.inputChannels),
      sampleRate: positiveInt(source.sampleRate, SAMPLE_RATE),
      bytes,
      playbackOn: source.playbackOn === true,
    };
  }
  if (mode === 'host-record') {
    return {
      mode,
      device: String(source.device || 'default'),
      channels: positiveInt(source.channels, channelConfig.inputChannels),
      sampleRate: SAMPLE_RATE,
      playbackOn: source.playbackOn !== false,
    };
  }
  if (mode === 'browser-record') {
    return {
      mode,
      channels: positiveInt(source.channels, channelConfig.inputChannels),
      sampleRate: SAMPLE_RATE,
      playbackOn: source.playbackOn !== false,
    };
  }
  return { mode: 'none', playbackOn: false };
}

function writeBufferToSource(session, buffer, done) {
  if (!session.sourceSocket || session.sourceSocket.destroyed) return;
  let offset = 0;
  const pump = () => {
    while (offset < buffer.length) {
      const end = Math.min(offset + 64 * 1024, buffer.length);
      if (!session.sourceSocket.write(buffer.subarray(offset, end))) {
        offset = end;
        session.sourceSocket.once('drain', pump);
        return;
      }
      offset = end;
    }
    if (done) done();
  };
  pump();
}

function writeSourceChunk(session, buffer) {
  return new Promise((resolve, reject) => {
    const socket = session && session.sourceSocket;
    if (!socket || socket.destroyed || !socket.writable) {
      reject(new Error('RX source socket is not ready'));
      return;
    }
    let settled = false;
    const finish = err => {
      if (settled) return;
      settled = true;
      socket.removeListener('error', onError);
      socket.removeListener('close', onClose);
      socket.removeListener('drain', onDrain);
      if (err) reject(err);
      else resolve();
    };
    const onError = err => finish(err);
    const onClose = () => finish(new Error('RX source socket closed'));
    const onDrain = () => finish();
    socket.once('error', onError);
    socket.once('close', onClose);
    try {
      if (socket.write(buffer)) finish();
      else socket.once('drain', onDrain);
    } catch (err) {
      finish(err);
    }
  });
}

function notifyBrowserRecordReady(session) {
  const client = session && session.browserRecordClient;
  if (!client || client.destroyed) return;
  sendJson(client, { type: 'online.source.ready', channel: session.channel });
}

function notifyBrowserFileReady(session) {
  const client = session && session.browserFileClient;
  if (!client || client.destroyed || session.browserFileUploadRequested) return;
  session.browserFileUploadRequested = true;
  sendJson(client, {
    type: 'online.source.upload',
    channel: session.channel,
    fileName: session.rxSource.fileName,
    bytes: session.rxSource.bytes,
  });
}

function writeBrowserRecordSource(socket, request) {
  const channel = String(request.channel || 'RX').toUpperCase();
  const session = onlineSessions.get(channel);
  if (!session || session.rxSource.mode !== 'browser-record'
      || session.browserRecordClient !== socket)
    return;
  if (!session.sourceStarted || !session.sourceSocket || session.sourceSocket.destroyed)
    return;

  const encoded = String(request.base64 || '');
  if (!encoded) return;
  const buffer = Buffer.from(encoded, 'base64');
  if (buffer.length > 64 * 1024) {
    if (!session.browserRecordOversizeLogged) {
      session.browserRecordOversizeLogged = true;
      sendSessionLog(session, 'browser record chunk dropped: too large');
    }
    return;
  }

  const frameBytes = Math.max(1, session.rxSource.channels) * 2;
  const length = buffer.length - (buffer.length % frameBytes);
  if (!length) return;
  if ((session.sourceSocket.writableLength || 0) > 512 * 1024) {
    if (!session.browserRecordBackpressureLogged) {
      session.browserRecordBackpressureLogged = true;
      sendSessionLog(session, 'browser record chunk dropped: source socket backpressure');
    }
    return;
  }

  session.browserRecordBackpressureLogged = false;
  const payload = session.rxSource.playbackOn
    ? buffer.subarray(0, length) : Buffer.alloc(length);
  session.sourceSocket.write(payload);
}

function browserFileSourceSession(socket, request) {
  const channel = String(request.channel || 'RX').toUpperCase();
  const session = onlineSessions.get(channel);
  if (!session || session.rxSource.mode !== 'browser-file'
      || session.browserFileClient !== socket)
    throw new Error('RX browser file source is not attached');
  if (!session.sourceStarted || !session.sourceSocket || session.sourceSocket.destroyed)
    throw new Error('RX browser file source is not ready');
  if (session.browserFileFinished)
    throw new Error('RX browser file source has finished');
  return session;
}

async function writeBrowserFileSource(socket, request) {
  const session = browserFileSourceSession(socket, request);
  const encoded = String(request.base64 || '');
  if (!encoded || encoded.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(encoded))
    throw new Error('RX browser file chunk is invalid');
  const buffer = Buffer.from(encoded, 'base64');
  if (!buffer.length) throw new Error('RX browser file chunk is empty');
  const frameBytes = Math.max(1, session.rxSource.channels) * 2;
  if (buffer.length % frameBytes !== 0)
    throw new Error('RX browser file chunk is not PCM frame aligned');
  if (session.browserFileBytesReceived + buffer.length > session.rxSource.bytes)
    throw new Error('RX browser file exceeds declared size');
  await writeSourceChunk(session, buffer);
  session.browserFileBytesReceived += buffer.length;
  return {
    bytesReceived: session.browserFileBytesReceived,
    totalBytes: session.rxSource.bytes,
  };
}

function finishBrowserFileSource(socket, request) {
  const session = browserFileSourceSession(socket, request);
  if (session.browserFileBytesReceived !== session.rxSource.bytes)
    throw new Error(`RX browser file size mismatch: ${session.browserFileBytesReceived}/${session.rxSource.bytes}`);
  session.browserFileFinished = true;
  session.sourceSocket.end();
  sendSessionLog(session, `RX source upload finished: ${session.browserFileBytesReceived} bytes`);
  return { bytesReceived: session.browserFileBytesReceived };
}

function startHostRecordSource(session) {
  if (session.hostRecordProcess || !session.sourceSocket || session.sourceSocket.destroyed) return;
  const source = session.rxSource;
  const device = source.device || 'default';
  const channels = Math.max(1, source.channels || 1);
  const args = ['-q', '-D', device, '-t', 'raw', '-f', 'S16_LE',
    '-r', String(SAMPLE_RATE), '-c', String(channels)];
  const child = childProcess.spawn('arecord', args, {
    cwd: DASHBOARD_ROOT,
    env: process.env,
    shell: false,
    windowsHide: true,
  });
  session.hostRecordProcess = child;
  sendSessionLog(session, `host record source started: ${device}`);
  child.stdout.on('data', chunk => {
    const stereo = pcm16MonoToStereo(chunk, channels);
    if (session.sourceSocket && !session.sourceSocket.destroyed)
      session.sourceSocket.write(source.playbackOn ? stereo : Buffer.alloc(stereo.length));
  });
  child.stderr.on('data', chunk => sendSessionLog(session, chunk.toString().trim()));
  child.on('error', err => sendSessionLog(session, `host record failed: ${err.message}`));
  child.on('close', code => {
    sendSessionLog(session, `host record exited: ${code}`);
    if (session.hostRecordProcess === child) session.hostRecordProcess = null;
  });
}

function maybeStartRxSource(session) {
  if (!session || !session.rxSource || session.rxSource.mode === 'none' || session.sourceStarted)
    return;
  if (!session.sourceSocket || session.sourceSocket.destroyed || !session.sourceConnected)
    return;
  if (!session.connectedStreams.has('input') || !session.connectedStreams.has('output')) {
    if (!session.sourceTimer) {
      session.sourceTimer = setTimeout(() => {
        session.sourceTimer = null;
        maybeStartRxSource(session);
      }, 100);
    }
    return;
  }

  session.sourceStarted = true;
  if (session.rxSource.mode === 'host-record') {
    startHostRecordSource(session);
    return;
  }
  if (session.rxSource.mode === 'browser-record') {
    sendSessionLog(session, 'browser record source ready');
    notifyBrowserRecordReady(session);
    return;
  }
  if (session.rxSource.mode === 'browser-file') {
    sendSessionLog(session, `browser file source ready: ${session.rxSource.fileName}`);
    notifyBrowserFileReady(session);
    return;
  }
  sendSessionLog(session, `RX source streaming: ${session.rxSource.fileName}`);
  writeBufferToSource(session, session.rxSource.buffer, () => {
    sendSessionLog(session, 'RX source stream finished');
    if (session.sourceSocket) session.sourceSocket.end();
  });
}

function connectRxSource(session) {
  const generation = session.streamGeneration || 0;
  const active = () => onlineSessions.get(session.channel) === session
    && (session.streamGeneration || 0) === generation;
  if (!session.rxSource || session.rxSource.mode === 'none') return;
  if (session.sourceConnected || session.sourceConnecting) return;
  if (session.sourceConnectTimer) {
    clearTimeout(session.sourceConnectTimer);
    session.sourceConnectTimer = null;
  }
  let attempts = 0;
  const connect = () => {
    if (!active() || session.sourceConnected) return;
    session.sourceConnecting = true;
    const socket = net.createConnection({ host: '127.0.0.1', port: session.localPorts.source });
    session.sourceSocket = socket;
    socket.on('connect', () => {
      if (!active()) { socket.destroy(); return; }
      session.sourceConnecting = false;
      session.sourceConnected = true;
      sendSessionLog(session, `RX source socket connected: 127.0.0.1:${session.localPorts.source}`);
      maybeStartRxSource(session);
    });
    socket.on('error', err => {
      if (!active()) return;
      session.sourceConnecting = false;
      if (++attempts === 1 || attempts % 30 === 0)
        sendSessionLog(session, `RX source socket retry: ${err.message}`);
    });
    socket.on('close', () => {
      if (!active()) return;
      session.sourceConnecting = false;
      session.sourceConnected = false;
      if (session.sourceStarted) return;
      if (++attempts <= 1000) setTimeout(connect, 100);
      else sendSessionLog(session, 'RX source socket failed: connect timeout');
    });
  };
  connect();
}

function scheduleRxSourceConnect(session, delayMs) {
  if (!session || !session.rxSource || session.rxSource.mode === 'none') return;
  if (session.sourceConnected || session.sourceConnecting || session.sourceConnectTimer) return;
  session.sourceConnectTimer = setTimeout(() => {
    session.sourceConnectTimer = null;
    connectRxSource(session);
  }, delayMs);
}

function startForwardedStreams(session) {
  if (!session || session.streamsStarted) return;
  session.streamsStarted = true;
  connectForwardedStream(session, 'input', session.localPorts.in, session.channelConfig.inputChannels);
  connectForwardedStream(session, 'output', session.localPorts.out, session.channelConfig.outputChannels);
}

async function resolveOnlineDevice(target) {
  let deviceId = target && target.adbDevice ? String(target.adbDevice).trim() : '';
  if (!deviceId) {
    const devices = await adbDevices();
    const ready = devices.devices.find(device => device.state === 'device');
    deviceId = ready ? ready.id : '';
  }
  if (!deviceId) throw new Error('no online adb device');
  const resolved = Object.assign({}, target, { adbDevice: deviceId });
  await prepareDevice(resolved);
  return resolved;
}

async function isAudioAidlDevice(target) {
  const result = await runAdbAllowFail(target, ['shell',
    'test -f /vendor/etc/rkaudio_effect_preprocess.json && echo yes'],
    { timeoutMs: 3000 });
  return String(result.stdout || '').trim() === 'yes';
}

async function startOnlineSession(message) {
  const channel = String(message.channel || 'TX').toUpperCase();
  const config = message.config;
  if (!config) throw new Error(`${channel} config is required before online simulation`);
  broadcastOnlineLog(channel, `Preparing ${channel} online session`);
  await stopOnlineSession(channel);

  const target = await resolveOnlineDevice(message.target || {});
  const deviceId = target.adbDevice;
  const platform = await detectDevicePlatform(target);
  if (!platform.category)
    throw new Error(`unsupported device platform: ${platform.soc}`);

  // Detect audio_aidl / VQE Plugin mode — VQE is built into the HAL, no separate binary needed.
  const audioAidl = channel === 'TX' && await isAudioAidlDevice(target);

  const platformDir = audioAidl ? '' : findPlatformInstallDir(platform.category);
  if (!audioAidl && !platformDir)
    throw new Error(`prebuilt platform not found: ${platform.category}`);

  const workspace = audioAidl ? '/tmp/_rockaa_aidl_' : await selectOnlineWorkspace(target, deviceId);
  const channelConfig = onlineChannelConfig(channel, config, message.channelConfig);
  const rxSource = channel === 'RX'
    ? normalizeRxSource(message, channelConfig)
    : { mode: 'none', playbackOn: false };
  const hostPlayback = normalizeHostPlayback(message.playback);
  const rxSourceActive = rxSource.mode !== 'none';
  const sedModelRequested = !!(message.sedModel && message.sedModel.base64);
  const sedAutoRequested = message.sedAuto === true;
  const sedRequested = sedModelRequested || sedAutoRequested;
  const useBundledV2 = shouldUseBundledV2Runtime(
    channel, message.version || 'v1', audioAidl);
  if (sedRequested) {
    if (String(channel).toUpperCase() !== 'TX')
      throw new Error('SED model is only supported on TX online simulation');
    if (String(message.version || 'v1').toLowerCase() !== 'v2')
      throw new Error('SED model requires a VQE v2 config');
    if (audioAidl)
      throw new Error('SED model deployment is not supported by the Audio AIDL runtime');
  }
  let sedModelRemotePath = '';
  const conf = audioAidl ? { file: '', name: '' } : localConfigFile(channel, config);
  let runtime = null;
  try {
    const audioHalType = audioAidl ? 'audio_aidl' : await detectAudioHalType(target);
    const localPorts = onlineLocalStreamPorts(deviceId, channel);
    const remotePorts = onlineRemotePorts(channel);

    if (!audioAidl) {
      runtime = await runtimePrefixForDevice(target, workspace, message.version || 'v1');
      if (runtime.missingRequiredVqe && !useBundledV2)
        throw new Error(`Matching VQE ${String(message.version || 'v1').toUpperCase()} runtime was not found on the device`);
      // VQE v2 dlopens every model file referenced by an enabled module.
      // A missing file makes librkaudio_vqe.so crash inside MNN init, so
      // verify the files before launching the capture runtime.
      if (String(message.version || 'v1').toLowerCase() === 'v2') {
        const missingModels = await checkOnlineModelFiles(target, config);
        if (missingModels.length)
          throw new Error(
            `model file(s) missing on device: ${missingModels.join(', ')}`
            + ' — push them to the device before starting online simulation');
      }
      broadcastOnlineLog(channel,
        `Using ${platform.category} workspace ${workspace}, HAL ${audioHalType}`);

      await runAdbAllowFail(target, ['shell',
        `killall -INT ${onlineRemoteProgram(channel)} 2>/dev/null || killall ${onlineRemoteProgram(channel)} 2>/dev/null || true`],
      { timeoutMs: 3000 });
      await runAdb(target, ['shell', `mkdir -p ${shellQuote(workspace)}`], { timeoutMs: 10000 });
      broadcastOnlineLog(channel, `Pushing platform runtime: ${platformDir}`);
      await runAdb(target, ['push', platformDir + path.sep + '.', workspace + '/'], { timeoutMs: 180000 });
      await runAdb(target, ['shell',
        `rm -rf ${shellQuote(`${workspace}/sed`)} ${shellQuote(`${workspace}/lib_sed`)}`],
      { timeoutMs: 10000 });
      await runAdb(target, ['push', conf.file, `${workspace}/${conf.name}`], { timeoutMs: 15000 });
      await runAdb(target, ['shell',
        `cd ${shellQuote(workspace)} && chmod +x utils/rockaa_capt utils/rockaa_play utils/rockaa_mix 2>/dev/null || true`],
      { timeoutMs: 10000 });
      const bundledV2Dir = path.join(platformDir, 'sed');
      if (useBundledV2) {
        await runAdb(target, ['shell', `mkdir -p ${shellQuote(`${workspace}/lib_sed`)}`], { timeoutMs: 10000 });
        for (const lib of ['librkaudio_common.so', 'librkaudio_vqe.so']) {
          const localLib = path.join(bundledV2Dir, lib);
          if (!fs.existsSync(localLib))
            throw new Error(`Bundled VQE v2 runtime library is missing: ${localLib}`);
          await runAdb(target, ['push', localLib, `${workspace}/lib_sed/${lib}`], { timeoutMs: 60000 });
        }
        broadcastOnlineLog(channel, 'Using bundled VQE v2 runtime: lib_sed');
      }
      if (sedRequested) {
        // SED ships as one self-contained runtime set (detect + common + v2
        // VQE) because the device-side common library ABI has to match the
        // detect build; loading the device's older common would break AGC.
        const sedLibDir = bundledV2Dir;
        if (!fs.existsSync(sedLibDir))
          throw new Error(`SED runtime is not bundled for platform ${platform.category} (missing sed/)`);
        const bundledModel = sedAutoRequested && !sedModelRequested
          ? bundledSedModelForPlatform(platformDir, platform) : null;
        if (sedAutoRequested && !sedModelRequested && !bundledModel)
          throw new Error(`SED model is not bundled for platform ${platform.buildPlatform}`);
        const modelBytes = sedModelRequested
          ? Buffer.from(String(message.sedModel.base64 || ''), 'base64')
          : fs.readFileSync(bundledModel.file);
        if (!modelBytes.length || modelBytes.length > 64 * 1024 * 1024)
          throw new Error('invalid SED rknn model payload');
        if (modelBytes.length < 64 || modelBytes.subarray(0, 4).toString('ascii') !== 'RKNN')
          throw new Error('invalid SED rknn model header');
        const localModel = sedModelRequested
          ? path.join(os.tmpdir(), `rockaa_html_sed_${process.pid}_${Date.now()}.rknn`)
          : bundledModel.file;
        if (sedModelRequested) fs.writeFileSync(localModel, modelBytes);
        try {
          await runAdb(target, ['push', localModel, `${workspace}/sed_model.rknn`], { timeoutMs: 60000 });
          const localDetect = path.join(sedLibDir, 'librkaudio_detect.so');
          if (!fs.existsSync(localDetect))
            throw new Error(`SED runtime library is missing: ${localDetect}`);
          await runAdb(target, ['push', localDetect,
            `${workspace}/lib_sed/librkaudio_detect.so`], { timeoutMs: 60000 });
        } finally {
          if (sedModelRequested) fs.unlink(localModel, () => {});
        }
        sedModelRemotePath = `${workspace}/sed_model.rknn`;
        const modelLabel = sedModelRequested
          ? message.sedModel.name || 'model'
          : `${bundledModel.profile}/${bundledModel.name}`;
        broadcastOnlineLog(channel,
          `SED model pushed: ${modelLabel} -> sed_model.rknn, runtime: lib_sed`);
      }
    } else {
      // audio_aidl HAL has built-in VQE + TCP streaming. Enable via system property.
      broadcastOnlineLog(channel, `audio_aidl HAL detected — built-in VQE, no binary push needed`);
      await runAdbAllowFail(target, ['shell',
        'setprop vendor.audio.preproc.tcp.enable 1'],
        { timeoutMs: 3000 });
    }

    broadcastOnlineLog(channel,
      `ADB forward: ${localPorts.in}->${audioAidl ? 'localabstract:rockaa_' + remotePorts.in : 'tcp:' + remotePorts.in}, ${localPorts.out}->${audioAidl ? 'localabstract:rockaa_' + remotePorts.out : 'tcp:' + remotePorts.out}`
        + (rxSourceActive ? `, ${localPorts.source}->${remotePorts.source}` : ''));
    await runAdbAllowFail(target, ['forward', '--remove', `tcp:${localPorts.in}`], { timeoutMs: 1000 });
    await runAdbAllowFail(target, ['forward', '--remove', `tcp:${localPorts.out}`], { timeoutMs: 1000 });
    await runAdbAllowFail(target, ['forward', '--remove', `tcp:${localPorts.source}`], { timeoutMs: 1000 });
    if (audioAidl) {
      // HAL uses Unix abstract sockets: @rockaa_19100, @rockaa_19101
      await runAdb(target, ['forward', `tcp:${localPorts.in}`, `localabstract:rockaa_${remotePorts.in}`], { timeoutMs: 5000 });
      await runAdb(target, ['forward', `tcp:${localPorts.out}`, `localabstract:rockaa_${remotePorts.out}`], { timeoutMs: 5000 });
    } else {
      await runAdb(target, ['forward', `tcp:${localPorts.in}`, `tcp:${remotePorts.in}`], { timeoutMs: 5000 });
      await runAdb(target, ['forward', `tcp:${localPorts.out}`, `tcp:${remotePorts.out}`], { timeoutMs: 5000 });
    }
    if (rxSourceActive)
      await runAdb(target, ['forward', `tcp:${localPorts.source}`, `tcp:${remotePorts.source}`], { timeoutMs: 5000 });

    let session;
    if (!audioAidl) {
      const runtime = await runtimePrefixForDevice(target, workspace, message.version || 'v1');
      let runtimePrefix = runtime.prefix;
      if (useBundledV2) {
        // Pin TX V2 to the packaged common/VQE pair. A firmware V2 library may
        // still use an older parameter ABI even when its major version matches.
        runtimePrefix += `export LD_LIBRARY_PATH=${shellQuote(`${workspace}/lib_sed`)}:$LD_LIBRARY_PATH; `
          + `export rockaa_vqe_v2_dir=${shellQuote(`${workspace}/lib_sed`)}; `;
      }
      const command = buildOnlineRunCommand({
        channel,
        workspace,
        runtimePrefix,
        confName: conf.name,
        audioHalType,
        channelConfig,
        remotePorts,
        perfInterval: message.perfInterval,
        perfEnabled: message.perfEnabled !== false,
        sedModelRemotePath,
        rxSourceRemotePath: rxSourceActive ? `tcp-listen:${remotePorts.source}` : '',
        rxHostRecordSource: rxSource.mode === 'host-record' || rxSource.mode === 'browser-record',
        rxPlaybackOn: rxSource.playbackOn === true,
      });
      const adb = findAdb();
      const child = childProcess.spawn(adb, adbArgsForTarget(target, ['shell', command]), {
        cwd: DASHBOARD_ROOT,
        env: process.env,
        shell: false,
        windowsHide: true,
      });
      session = {
        channel,
        deviceId,
        workspace,
        platform,
        platformDir,
        localPorts,
        remotePorts,
        channelConfig,
        clients: new Set(),
        sockets: new Set(),
        connectedStreams: new Set(),
        history: [],
        streamsStarted: false,
        process: child,
        rxSource,
        sourceSocket: null,
        sourceConnected: false,
        sourceConnecting: false,
        sourceStarted: false,
        sourceTimer: null,
        sourceConnectTimer: null,
        hostRecordProcess: null,
        browserRecordClient: null,
        browserRecordBackpressureLogged: false,
        browserRecordOversizeLogged: false,
        browserFileClient: null,
        browserFileBytesReceived: 0,
        browserFileFinished: false,
        browserFileUploadRequested: false,
        hostPlayback,
        hostPlaybackProcess: null,
        hostPlaybackSampleRate: SAMPLE_RATE,
        hostPlaybackWarned: false,
        lastStartMessage: message,
        shellCommand: command,
        adbPath: adb,
        adbTarget: target,
        audioAidl: false,
      };
      onlineSessions.set(channel, session);
      sendSessionLog(session, `Start command: ${command}`);
      attachOnlineProcessOutput(session, child);
      child.on('error', err => {
        if (session.process !== child) return;
        sendSessionLog(session, `${onlineRemoteProgram(channel)} failed: ${err.message}`);
        if (onlineSessions.get(channel) === session && session.process === child)
          onlineSessions.delete(channel);
      });
      child.on('close', code => {
        if (session.process !== child) return;
        sendSessionLog(session, `${onlineRemoteProgram(channel)} exited: ${code}`);
        if (onlineSessions.get(channel) === session && session.process === child)
          onlineSessions.delete(channel);
      });
    } else {
      // audio_aidl: no child process — HAL streams directly via TCP
      session = {
        channel,
        deviceId,
        workspace,
        platform,
        platformDir: '',
        localPorts,
        remotePorts,
        channelConfig,
        clients: new Set(),
        sockets: new Set(),
        connectedStreams: new Set(),
        history: [],
        streamsStarted: false,
        process: null,
        rxSource,
        sourceSocket: null,
        sourceConnected: false,
        sourceConnecting: false,
        sourceStarted: false,
        sourceTimer: null,
        sourceConnectTimer: null,
        hostRecordProcess: null,
        browserRecordClient: null,
        browserRecordBackpressureLogged: false,
        browserRecordOversizeLogged: false,
        browserFileClient: null,
        browserFileBytesReceived: 0,
        browserFileFinished: false,
        browserFileUploadRequested: false,
        hostPlayback,
        hostPlaybackProcess: null,
        hostPlaybackSampleRate: SAMPLE_RATE,
        hostPlaybackWarned: false,
        lastStartMessage: message,
        shellCommand: '',
        adbPath: findAdb(),
        adbTarget: target,
        audioAidl: true,
      };
      onlineSessions.set(channel, session);
      sendSessionLog(session, 'audio_aidl: waiting for HAL TCP stream (start recording on device)');
    }
    startForwardedStreams(session);
    if (rxSourceActive) scheduleRxSourceConnect(session, 1200);

    return {
      channel,
      deviceId,
      workspace,
      soc: platform.soc,
      buildPlatform: platform.buildPlatform,
      category: platform.category,
      platformDir,
      audioHalType,
      localPorts,
      remotePorts,
      channelConfig,
      audioAidl,
      rxSource: {
        mode: rxSource.mode,
        fileName: rxSource.fileName,
        device: rxSource.device,
        playbackOn: rxSource.playbackOn,
      },
      command: session.shellCommand || '',
    };
  } finally {
    if (conf.file) fs.unlink(conf.file, () => {});
  }
}

function setOnlinePlayback(message) {
  const channel = String(message.channel || 'TX').toUpperCase();
  const session = onlineSessions.get(channel);
  if (!session)
    return { ok: false, channel, active: false };
  const playback = normalizeHostPlayback(message.playback);
  session.hostPlayback = playback;
  session.hostPlaybackWarned = false;
  stopHostPlayback(session);
  const choice = playback.stream
    ? `${playback.stream}-ch${playback.channel}`
    : 'off';
  sendSessionLog(session, `host playback selected: ${choice}`);
  return { ok: true, channel, active: !!playback.stream, playback };
}

function attachOnlineStream(socket, request) {
  const channel = String(request.channel || 'TX').toUpperCase();
  const session = onlineSessions.get(channel);
  if (!session) {
    sendJson(socket, { type: 'error', message: `no active ${channel} online session` });
    return;
  }
  session.clients.add(socket);
  if (session.history)
    for (const entry of session.history) sendJson(socket, entry);
  if (session.rxSource.mode === 'browser-record'
      && (!session.browserRecordClient || session.browserRecordClient.destroyed))
    session.browserRecordClient = socket;
  if (session.rxSource.mode === 'browser-file'
      && (!session.browserFileClient || session.browserFileClient.destroyed))
    session.browserFileClient = socket;
  sendJson(socket, {
    type: 'log',
    message: `attached ${channel} stream: localhost ${session.localPorts.in}/${session.localPorts.out}`,
  });
  if (session.browserRecordClient === socket && session.sourceStarted)
    notifyBrowserRecordReady(session);
  if (session.browserFileClient === socket && session.sourceStarted)
    notifyBrowserFileReady(session);
  const detach = () => {
    session.clients.delete(socket);
    if (session.browserRecordClient === socket) {
      session.browserRecordClient = null;
      for (const client of session.clients) {
        if (!client.destroyed) {
          session.browserRecordClient = client;
          if (session.sourceStarted) notifyBrowserRecordReady(session);
          break;
        }
      }
    }
    if (session.browserFileClient === socket) {
      session.browserFileClient = null;
      if (!session.browserFileUploadRequested) {
        for (const client of session.clients) {
          if (!client.destroyed) {
            session.browserFileClient = client;
            if (session.sourceStarted) notifyBrowserFileReady(session);
            break;
          }
        }
      }
    }
  };
  socket.on('close', detach);
  socket.on('error', detach);
}

// ── acoustic evaluation ──

const EVAL_CAPTURE_STARTUP_WAIT_MS = 1200;

function broadcastPaeLog(message) {
  const body = { type: 'pae.log', message: String(message) };
  for (const client of clients) sendJson(client, body);
}

function evalOutputBaseDir() {
  return path.join(HTML_ROOT, 'output');
}

function evalSafeName(text) {
  return String(text || 'unknown').trim().replace(/[^0-9A-Za-z_.-]/g, '_') || 'unknown';
}

function evalTimestamp() {
  const now = new Date();
  const pad = n => String(n).padStart(2, '0');
  return `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}_`
    + `${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
}

function readEvalImages(dir) {
  const images = {};
  const candidates = [
    'waveform.png', 'spectrogram.png', 'mic_waveform.png', 'far_waveform.png',
    'mic_spectrogram.png', 'far_spectrogram.png', 'tone_spectrum.png', 'psd.png',
    'sweep_spectrogram.png', 'sweep_track.png', 'sweep_magcurve.png',
    'capture_overview.png', 'impulse_etc.png', 'frequency_response.png',
    'capture_spectrogram.png', 'group_delay.png', 'waterfall.png',
    'diagnostic_map.png',
  ];
  for (const name of candidates) {
    const full = path.join(dir, name);
    if (fs.existsSync(full)) {
      images[name] = 'data:image/png;base64,' + fs.readFileSync(full).toString('base64');
    }
  }
  return images;
}

function readEvalMetrics(dir) {
  const metricsPath = path.join(dir, 'metrics.json');
  if (!fs.existsSync(metricsPath)) return null;
  try {
    return JSON.parse(fs.readFileSync(metricsPath, 'utf8'));
  } catch (err) {
    return null;
  }
}

function findEvalReportDir(baseDir, evalOutput) {
  const lines = String(evalOutput || '').split(/\r?\n/).map(l => l.trim()).filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i];
    if (fs.existsSync(path.join(line, 'report.md'))) return line;
  }
  if (baseDir && fs.existsSync(baseDir)) {
    let entries = [];
    try { entries = fs.readdirSync(baseDir, { withFileTypes: true }); } catch (_) {}
    const dirs = entries.filter(e => e.isDirectory()).map(e => path.join(baseDir, e.name));
    dirs.sort((a, b) => {
      try { return fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs; } catch (_) { return 0; }
    });
    for (const dir of dirs) {
      if (fs.existsSync(path.join(dir, 'report.md'))) return dir;
    }
  }
  return '';
}

const paeSession = {
  running: false,
  cancelRequested: false,
  target: null,
  workspace: '',
  remoteSource: '',
  remoteCapture: '',
  children: new Set(),
};

function ensurePaeActive() {
  if (paeSession.cancelRequested) throw new Error('PAE_CANCELLED');
}

function paeTrackedOptions(options) {
  return Object.assign({}, options, { childSet: paeSession.children });
}

async function stopProfessionalAcousticEvaluation(message) {
  if (!paeSession.running) return { stopped: false, reason: 'not-running' };
  paeSession.cancelRequested = true;
  broadcastPaeLog('Cancellation requested; stopping device playback and capture...');
  const target = paeSession.target || await resolveOnlineDevice(message.target || {});
  await runAdbAllowFail(target, ['shell',
    '(killall -INT rockaa_capt 2>/dev/null || pkill -INT rockaa_capt 2>/dev/null || true); '
      + '(killall -INT rockaa_play 2>/dev/null || pkill -INT rockaa_play 2>/dev/null || true)'],
  { timeoutMs: 5000 });
  for (const child of Array.from(paeSession.children)) {
    if (child.exitCode === null && !child.signalCode) child.kill();
  }
  if (paeSession.workspace) {
    const files = [paeSession.remoteCapture, paeSession.remoteSource].filter(Boolean);
    if (files.length) {
      await runAdbAllowFail(target, ['shell', `rm -f ${files.map(shellQuote).join(' ')}`],
        { timeoutMs: 5000 });
    }
  }
  broadcastPaeLog('Evaluation cancelled; device playback and capture stopped');
  return { stopped: true };
}

async function runAcousticEvaluation(message, options) {
  const sampleRate = Number(message.sampleRate) || 16000;
  const emitLog = options.emitLog;
  emitLog(`Evaluation start: sample rate = ${sampleRate} Hz`);

  const target = await resolveOnlineDevice(message.target || {});
  paeSession.target = target;
  ensurePaeActive();
  const deviceId = target.adbDevice;

  const sourcePath = options.sourcePath;
  const sourceSampleRate = readWavSampleRate(sourcePath);
  if (sourceSampleRate !== sampleRate) {
    throw new Error(`Evaluation source sample rate mismatch: expected ${sampleRate} Hz, got ${sourceSampleRate || 'unknown'} Hz`);
  }
  emitLog(`Source audio: ${sourcePath}`);

  const platform = await detectDevicePlatform(target);
  if (!platform.category)
    throw new Error(`Cannot match build platform from SoC info: ${platform.soc}`);
  const platformDir = findPlatformInstallDir(platform.category);
  if (!platformDir)
    throw new Error(`Pre-built platform binaries not found (platforms/${platform.category})`);
  emitLog(`Platform: ${platform.category} (${platformDir})`);

  let workspace = '';
  try {
    workspace = await selectOnlineWorkspace(target, deviceId, 32768, ['/tmp']);
  } catch (_) {
    throw new Error('EVAL_TMP_NO_SPACE');
  }
  paeSession.workspace = workspace;
  ensurePaeActive();
  emitLog(`Workspace: ${workspace}`);

  const audioHalType = await detectAudioHalType(target);
  emitLog(`Audio HAL: ${audioHalType}`);

  emitLog('Cleaning up previous processes');
  await runAdbAllowFail(target, ['shell',
    'killall -INT rockaa_capt rockaa_play 2>/dev/null || killall rockaa_capt rockaa_play 2>/dev/null || true'],
  paeTrackedOptions({ timeoutMs: 3000 }));
  await runAdbAllowFail(target, ['shell',
    `rm -f ${shellQuote(workspace)}/eval_capture_*.wav ${shellQuote(workspace + '/source')}/aud_*.wav`],
  paeTrackedOptions({ timeoutMs: 5000 }));
  ensurePaeActive();

  emitLog('Deploying platform runtime and source audio');
  await runAdb(target, ['shell', `mkdir -p ${shellQuote(workspace + '/source')}`], paeTrackedOptions({ timeoutMs: 10000 }));
  await runAdb(target, ['push', platformDir + path.sep + '.', workspace + '/'], paeTrackedOptions({ timeoutMs: 180000 }));
  ensurePaeActive();
  await runAdb(target, ['push', sourcePath, workspace + '/source/'], paeTrackedOptions({ timeoutMs: 60000 }));
  await runAdb(target, ['shell',
    `cd ${shellQuote(workspace)} && chmod +x utils/rockaa_capt utils/rockaa_play && ls -l utils/rockaa_capt utils/rockaa_play`],
  paeTrackedOptions({ timeoutMs: 10000 }));
  ensurePaeActive();

  const stamp = evalTimestamp();
  const outputPrefix = options.outputPrefix ? `${evalSafeName(options.outputPrefix)}_` : '';
  const localBase = path.join(evalOutputBaseDir(),
    `${outputPrefix}${evalSafeName(deviceId)}_${sampleRate}_${stamp}`);
  fs.mkdirSync(localBase, { recursive: true });
  const remoteSource = `${workspace}/source/${path.basename(sourcePath)}`;
  const remoteCapture = `${workspace}/eval_capture_${sampleRate}_${stamp}.wav`;
  paeSession.remoteSource = remoteSource;
  paeSession.remoteCapture = remoteCapture;
  const localCapture = path.join(localBase, path.basename(remoteCapture));

  const runtimePrefix = `export LD_LIBRARY_PATH=${shellQuote(workspace + '/lib')}:$LD_LIBRARY_PATH; `;
  const cdPrefix = `cd ${shellQuote(workspace)} || exit 1; `;
  const captureCommand = `${cdPrefix}${runtimePrefix}rm -f ${shellQuote(remoteCapture)}; `
    + `./utils/rockaa_capt ${shellQuote(remoteCapture)} --hal ${shellQuote(audioHalType)} `
    + `-c 2 -C 1 -b 16 -r ${sampleRate} -p 256 -Z 1`;

  emitLog(`Starting capture: ${captureCommand}`);
  const adb = findAdb();
  const captureChild = childProcess.spawn(adb,
    adbArgsForTarget(target, ['shell', captureCommand]), {
      cwd: DASHBOARD_ROOT,
      env: process.env,
      shell: false,
      windowsHide: true,
    });
  paeSession.children.add(captureChild);

  const captureExited = new Promise(resolve => {
    captureChild.on('close', code => {
      paeSession.children.delete(captureChild);
      emitLog(`Capture process exited: ${code}`);
      resolve(code);
    });
  });
  captureChild.stdout.on('data', chunk => {
    const text = chunk.toString().trim();
    if (text) emitLog(text);
  });
  captureChild.stderr.on('data', chunk => {
    const text = chunk.toString().trim();
    if (text) emitLog(text);
  });

  await new Promise(resolve => setTimeout(resolve, EVAL_CAPTURE_STARTUP_WAIT_MS));
  ensurePaeActive();
  if (captureChild.exitCode !== null || captureChild.signalCode) {
    throw new Error('Device capture exited early');
  }

  emitLog('Playing evaluation source and recording...');
  const playCommand = `${cdPrefix}${runtimePrefix}`
    + `./utils/rockaa_play ${shellQuote(remoteSource)} --hal ${shellQuote(audioHalType)} `
    + `-c 2 -r ${sampleRate} -b 16 -p 256 -Z 1`;
  let playOk = true;
  try {
    await runAdb(target, ['shell', playCommand], paeTrackedOptions({ timeoutMs: 300000 }));
  } catch (err) {
    playOk = false;
    emitLog(`Playback error: ${err.message}`);
  }

  emitLog('Playback finished, stopping device capture...');
  await runAdbAllowFail(target, ['shell',
    'killall -INT rockaa_capt 2>/dev/null || pkill -INT rockaa_capt 2>/dev/null || true'],
  paeTrackedOptions({ timeoutMs: 3000 }));

  await Promise.race([
    captureExited,
    new Promise(resolve => setTimeout(resolve, 10000)),
  ]);
  if (captureChild.exitCode === null) {
    captureChild.kill();
  }

  if (!playOk) throw new Error('Device playback failed');
  ensurePaeActive();

  emitLog('Pulling device recording...');
  await runAdb(target, ['pull', remoteCapture, localCapture], paeTrackedOptions({ timeoutMs: 60000 }));
  if (!fs.existsSync(localCapture))
    throw new Error('Failed to pull device recording');
  emitLog(`Pulled: ${localCapture}`);
  await runAdbAllowFail(target, ['shell',
    `rm -f ${shellQuote(remoteCapture)} ${shellQuote(remoteSource)}`],
  paeTrackedOptions({ timeoutMs: 5000 }));
  ensurePaeActive();

  emitLog('Analyzing recording and generating report...');
  const result = await options.analyze(sourcePath, localCapture, localBase);
  ensurePaeActive();
  emitLog(result.stdout.trim());

  const reportDir = findEvalReportDir(localBase, result.stdout);
  if (!reportDir) throw new Error('Evaluation report not found');

  const reportText = fs.readFileSync(path.join(reportDir, 'report.md'), 'utf8');
  const images = readEvalImages(reportDir);
  const metrics = readEvalMetrics(reportDir);

  emitLog(`Evaluation report generated: ${reportDir}`);
  return { reportDir, reportText, images, metrics };
}

async function runProfessionalAcousticEvaluation(message) {
  if (paeSession.running) throw new Error('PAE evaluation is already running');
  const sampleRate = Number(message.sampleRate) || 16000;
  if (sampleRate !== 16000)
    throw new Error('PAE v1 currently validates 16 kHz only');
  const duration = Math.max(2, Math.min(10, Number(message.duration) || 5));
  const startHz = Math.max(40, Math.min(1000, Number(message.startHz) || 80));
  const endHz = Math.max(startHz + 100, Math.min(7200, Number(message.endHz) || 7200));
  const language = message.language === 'en' ? 'en' : 'zh';
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rockaa_pae_'));
  const sourcePath = path.join(workDir, 'pae_ess_16000_2ch.wav');
  const paeScript = path.join(HTML_ROOT, 'evaluation', 'pae_eval', 'pae_cli.py');
  paeSession.running = true;
  paeSession.cancelRequested = false;
  paeSession.target = message.target || null;
  paeSession.workspace = '';
  paeSession.remoteSource = '';
  paeSession.remoteCapture = '';
  paeSession.children.clear();
  try {
    broadcastPaeLog(`Generating ESS: ${startHz}-${endHz} Hz, ${duration}s`);
    await run('python3', [
      paeScript, 'generate', '--out', sourcePath,
      '--sample-rate', String(sampleRate), '--duration', String(duration),
      '--start-hz', String(startHz), '--end-hz', String(endHz),
    ], paeTrackedOptions({ timeoutMs: 30000 }));
    ensurePaeActive();
    return await runAcousticEvaluation(message, {
      sourcePath,
      outputPrefix: 'pae',
      emitLog: broadcastPaeLog,
      analyze: (source, capture, output) => run('python3', [
        paeScript, 'analyze', '--source', source,
        '--capture', capture, '--out', output,
        '--duration', String(duration), '--start-hz', String(startHz),
        '--end-hz', String(endHz), '--language', language,
      ], paeTrackedOptions({ timeoutMs: 180000 })),
    });
  } finally {
    for (const child of Array.from(paeSession.children)) {
      if (child.exitCode === null && !child.signalCode) child.kill();
    }
    paeSession.children.clear();
    paeSession.running = false;
    paeSession.target = null;
    paeSession.workspace = '';
    paeSession.remoteSource = '';
    paeSession.remoteCapture = '';
    fs.rm(workDir, { recursive: true, force: true }, () => {});
  }
}

async function restartOnlineProcess(channel, newConfig) {
  const ch = String(channel).toUpperCase();
  const session = onlineSessions.get(ch);
  if (!session || !session.shellCommand)
    throw new Error(`no active ${ch} online session`);
  if (session.restartInProgress)
    throw new Error(`${ch} parameter update is already in progress`);
  session.restartInProgress = true;
  let conf = null;
  let oldProcess = null;
  try {
    conf = localConfigFile(ch, newConfig);
    broadcastOnlineLog(ch, 'Pushing updated config');
    await runAdb(session.adbTarget, ['push', conf.file,
      `${session.workspace}/${conf.name}`], { timeoutMs: 15000 });

    // Retire this generation before signalling: the old child may close
    // while the ADB signal command is still awaiting its reply.
    oldProcess = session.process;
    session.process = null;
    session.streamGeneration = (session.streamGeneration || 0) + 1;
    const oldExited = oldProcess && oldProcess.exitCode === null
      && !oldProcess.signalCode
      ? new Promise(resolve => oldProcess.once('close', resolve))
      : Promise.resolve();
    await runAdb(session.adbTarget, ['shell',
      `pkill -INT ${onlineRemoteProgram(ch)} 2>/dev/null || `
      + `killall -INT ${onlineRemoteProgram(ch)} 2>/dev/null || true`],
    { timeoutMs: 2000 });

    // Keep the ADB child alive until the remote process has actually exited.
    // A local child.kill() does not prove that ALSA and TCP ports are released.
    if (session.hostRecordProcess) {
      session.hostRecordProcess.kill();
      session.hostRecordProcess = null;
    }
    stopHostPlayback(session);

    // Destroy old streaming sockets so they don't auto-reconnect
    for (const sock of session.sockets) sock.destroy();
    session.sockets.clear();
    session.connectedStreams.clear();

    // Reset source state
    session.sourceStarted = false;
    if (session.sourceSocket) {
      session.sourceSocket.destroy();
      session.sourceSocket = null;
    }
    session.sourceConnected = false;
    session.sourceConnecting = false;
    if (session.sourceTimer) { clearTimeout(session.sourceTimer); session.sourceTimer = null; }
    if (session.sourceConnectTimer) { clearTimeout(session.sourceConnectTimer); session.sourceConnectTimer = null; }

    let exitTimer;
    try {
      await Promise.race([oldExited, new Promise((_, reject) => {
        exitTimer = setTimeout(() => reject(new Error(
          `${onlineRemoteProgram(ch)} did not stop; replacement was not started`)), 5000);
      })]);
    } finally {
      clearTimeout(exitTimer);
    }
    if (onlineSessions.get(ch) !== session)
      throw new Error(`${ch} session stopped during parameter update`);

    // Spawn new process
    const child = childProcess.spawn(session.adbPath,
      adbArgsForTarget(session.adbTarget, ['shell', session.shellCommand]), {
        cwd: DASHBOARD_ROOT,
        env: process.env,
        shell: false,
        windowsHide: true,
      });
    session.process = child;
    sendSessionLog(session, `Restart command: ${session.shellCommand}`);

    attachOnlineProcessOutput(session, child);
    child.on('error', err => {
      if (session.process !== child) return;
      sendSessionLog(session, `${onlineRemoteProgram(ch)} failed: ${err.message}`);
      if (onlineSessions.get(ch) === session && session.process === child)
        onlineSessions.delete(ch);
    });
    child.on('close', code => {
      if (session.process !== child) return;
      sendSessionLog(session, `${onlineRemoteProgram(ch)} exited: ${code}`);
      if (onlineSessions.get(ch) === session && session.process === child)
        onlineSessions.delete(ch);
    });

    // Reconnect streams — reset flag so startForwardedStreams actually runs
    session.receivedStreams = new Set();
    session.streamsStarted = false;
    startForwardedStreams(session);

    // Reconnect RX source if needed
    if (session.rxSource && session.rxSource.mode !== 'none')
      scheduleRxSourceConnect(session, 1800);

    if (ch === 'TX') {
      const deadline = Date.now() + 5000;
      while (session.receivedStreams.size < 2) {
        if (child.exitCode !== null || child.signalCode || onlineSessions.get(ch) !== session)
          throw new Error(`${onlineRemoteProgram(ch)} exited during parameter update`);
        if (Date.now() >= deadline)
          throw new Error('TX parameter update timed out waiting for input/output PCM');
        await new Promise(resolve => setTimeout(resolve, 50));
      }
    }

    return { ok: true, channel: ch, workspace: session.workspace };
  } catch (err) {
    // Retain ownership if signalling or waiting failed, so Stop can still
    // clean up the old ADB child. Never spawn over a process that did not exit.
    if (!session.process && oldProcess && oldProcess.exitCode === null && !oldProcess.signalCode)
      session.process = oldProcess;
    throw err;
  } finally {
    session.restartInProgress = false;
    if (conf) fs.unlink(conf.file, () => {});
  }
}

// ── codec mixer debugging ──

function broadcastCodecLog(message) {
  const body = { type: 'codec.log', message: String(message) };
  for (const client of clients) sendJson(client, body);
}

const codecDeployCache = new Map();

async function ensureCodecMixDeployed(target) {
  const deviceId = target && target.adbDevice ? String(target.adbDevice).trim() : '';
  const cacheKey = deviceId;
  if (codecDeployCache.has(cacheKey)) return codecDeployCache.get(cacheKey);

  const platform = await detectDevicePlatform(target);
  if (!platform.category)
    throw new Error(`Cannot match build platform from SoC info: ${platform.soc}`);
  const platformDir = findPlatformInstallDir(platform.category);
  if (!platformDir)
    throw new Error(`Pre-built platform not found: ${platform.category}`);

  const workspace = await selectOnlineWorkspace(target, deviceId);
  const checkResult = await runAdbAllowFail(target, ['shell',
    `test -f ${shellQuote(workspace + '/utils/rockaa_mix')} && echo yes || echo no`],
  { timeoutMs: 3000 });

  if (!checkResult.stdout.includes('yes')) {
    broadcastCodecLog(`Deploying rockaa_mix (${platform.category}) to ${workspace}`);
    await runAdb(target, ['shell', `mkdir -p ${shellQuote(workspace + '/utils')}`], { timeoutMs: 5000 });
    await runAdb(target, ['push',
      path.join(platformDir, 'utils', 'rockaa_mix'),
      workspace + '/utils/'], { timeoutMs: 30000 });
    await runAdb(target, ['shell',
      `chmod +x ${shellQuote(workspace + '/utils/rockaa_mix')}`], { timeoutMs: 3000 });
  }

  const info = { workspace, platformDir, deviceId, platform };
  codecDeployCache.set(cacheKey, info);
  return info;
}

async function getCodecCards(target) {
  const result = await runAdb(target, ['shell', 'cat /proc/asound/cards 2>/dev/null'], { timeoutMs: 5000 });
  const cards = [];
  for (const line of result.stdout.split(/\r?\n/)) {
    const m = line.match(/^\s*(\d+)\s*\[([^\]]*)\]\s*:\s*(\S+)\s*-\s*(.*)$/);
    if (m) {
      cards.push({
        index: parseInt(m[1]),
        id: m[2].trim(),
        driver: m[3].trim(),
        name: m[4].trim(),
      });
    }
  }
  return { cards };
}

function parseRockaaMixOutput(text) {
  const lines = String(text || '').split(/\r?\n/);
  const mixerName = (lines[0] || '').match(/Mixer name: '(.+)'/)?.[1] || '';
  const numControls = parseInt((lines[1] || '').match(/Number of controls: (\d+)/)?.[1] || '0');

  const controls = [];
  for (let i = 3; i < lines.length; i++) {
    const line = lines[i];
    if (!line.trim()) continue;
    const parts = line.split('\t');
    if (parts.length < 5) continue;

    const num = parseInt(parts[0]);
    const type = parts[1].trim();
    const count = parseInt(parts[2]);
    const name = parts[3].trim();
    const valueParts = parts.slice(4);

    if (type === 'ENUM') {
      const options = [];
      let selectedIndex = 0;
      for (const vp of valueParts) {
        const trimmed = vp.trim();
        if (!trimmed) continue;
        if (trimmed.startsWith('>')) {
          selectedIndex = options.length;
          options.push(trimmed.substring(1));
        } else {
          options.push(trimmed);
        }
      }
      controls.push({ num, type, count, name, selectedIndex, options });
    } else if (type === 'BOOL') {
      const val = valueParts[0] && valueParts[0].trim() === 'On';
      controls.push({ num, type, count, name, value: val });
    } else if (type === 'INT' || type === 'INT64') {
      const rangeMatch = valueParts.find(v => v.includes('dsrange'));
      let range = null;
      let rangeIdx = -1;
      if (rangeMatch) {
        const rm = rangeMatch.match(/dsrange\s+(-?\d+)->(-?\d+)/);
        if (rm) range = { min: parseInt(rm[1]), max: parseInt(rm[2]) };
        rangeIdx = valueParts.indexOf(rangeMatch);
      }
      const valueFields = rangeIdx >= 0 ? valueParts.slice(0, rangeIdx) : valueParts;
      const values = valueFields.map(v => parseInt(v.trim())).filter(n => !isNaN(n));
      controls.push({ num, type, count, name, values, range });
    } else {
      controls.push({ num, type, count, name, textValue: valueParts.map(v => v.trim()).filter(Boolean) });
    }
  }

  return { mixerName, numControls, controls };
}

async function getCodecControls(target, card) {
  broadcastCodecLog(`Loading mixer controls: card ${card}`);
  const deploy = await ensureCodecMixDeployed(target);
  const workspace = deploy.workspace;
  const runtimePrefix = `export LD_LIBRARY_PATH=${shellQuote(workspace + '/lib')}:$LD_LIBRARY_PATH; `;
  const cmd = `cd ${shellQuote(workspace)} || exit 1; ${runtimePrefix}./utils/rockaa_mix -D ${card} -a -t`;
  const result = await runAdb(target, ['shell', cmd], { timeoutMs: 15000 });
  const parsed = parseRockaaMixOutput(result.stdout);
  broadcastCodecLog(`${parsed.mixerName || 'Mixer'}: ${parsed.controls.length} controls`);
  return parsed;
}

async function setCodecControl(target, card, name, values) {
  const deploy = await ensureCodecMixDeployed(target);
  const workspace = deploy.workspace;
  const vals = (values || []).map(v => shellQuote(String(v))).join(' ');
  const cmd = `cd ${shellQuote(workspace)} || exit 1; ./utils/rockaa_mix -D ${card} ${shellQuote(name)} ${vals}`;
  const result = await runAdb(target, ['shell', cmd], { timeoutMs: 10000 });
  broadcastCodecLog(`Set: ${name} = ${values.join(' ')}`);
  return { ok: true, output: result.stdout.trim() };
}

// ── offline VQE simulation ──

// Host-side sampler for the offline runner (vqe_ai_test/vqe_ao_test are
// prebuilt external binaries without rockaa_perf.c, so the bridge samples
// the child through /proc instead). CPU share is top-style across all
// cores; memory is RSS from /proc/<pid>/status.
function readHostProcPidCpuTicks(pid) {
  try {
    const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
    const rest = stat.slice(stat.lastIndexOf(')') + 2).split(/\s+/);
    // fields after comm: state(0) .. utime(11), stime(12)
    return parseInt(rest[11], 10) + parseInt(rest[12], 10);
  } catch (_) {
    return null;
  }
}

function readHostSysCpuTicks() {
  try {
    const parts = fs.readFileSync('/proc/stat', 'utf8').split('\n')[0].split(/\s+/);
    let total = 0;
    for (let i = 1; i < parts.length; i++) total += parseInt(parts[i], 10) || 0;
    return total;
  } catch (_) {
    return null;
  }
}

function readHostProcPidRssKb(pid) {
  try {
    const status = fs.readFileSync(`/proc/${pid}/status`, 'utf8');
    const m = status.match(/^VmRSS:\s+(\d+)\s+kB/m);
    return m ? parseInt(m[1], 10) : null;
  } catch (_) {
    return null;
  }
}

function startOfflinePerfSampler(pid) {
  let prevProc = readHostProcPidCpuTicks(pid);
  let prevSys = readHostSysCpuTicks();
  const cpuSamples = [];
  const memSamples = [];
  const sample = () => {
    const proc = readHostProcPidCpuTicks(pid);
    const sys = readHostSysCpuTicks();
    const rss = readHostProcPidRssKb(pid);
    if (rss !== null) memSamples.push(rss);
    if (prevProc !== null && prevSys !== null && sys > prevSys) {
      let cpu = (proc - prevProc) / (sys - prevSys) * 100;
      cpuSamples.push(Math.min(100, Math.max(0, cpu)));
    }
    if (proc !== null) prevProc = proc;
    if (sys !== null) prevSys = sys;
  };
  const firstSample = setTimeout(sample, 0);
  // Offline workers often finish in less than one second. A short interval
  // provides useful CPU/RSS samples without delaying their completion.
  const timer = setInterval(sample, 100);
  return {
    stop() {
      clearTimeout(firstSample);
      clearInterval(timer);
      const cpuSum = cpuSamples.reduce((sum, value) => sum + value, 0);
      const memSum = memSamples.reduce((sum, value) => sum + value, 0);
      return {
        cpu_avg: cpuSamples.length
          ? Math.round(cpuSum / cpuSamples.length * 100) / 100 : null,
        cpu_peak: cpuSamples.length
          ? Math.round(Math.max(...cpuSamples) * 100) / 100 : null,
        mem_avg_kb: memSamples.length
          ? Math.round(memSum / memSamples.length) : null,
        mem_peak_kb: memSamples.length ? Math.max(...memSamples) : null,
      };
    },
  };
}

// vqe_ai_test prints e.g.
//   Finished, speech_time = 63.584000, cost_time = 16.581241 load = 26.08%
function parseOfflineRtf(output) {
  const m = String(output || '').match(/speech_time\s*=\s*([\d.]+).*?cost_time\s*=\s*([\d.]+)/);
  if (!m) return null;
  const speech = parseFloat(m[1]);
  const cost = parseFloat(m[2]);
  if (!Number.isFinite(speech) || speech <= 0) return null;
  return {
    rtf: Math.round(cost / speech * 10000) / 10000,
    speech_s: speech,
    cost_s: cost,
  };
}

function findVqeRuntimeDir(version) {
  const normalized = String(version || 'v1').toLowerCase();
  const runtimeName = normalized === 'v2' ? 'vqe_v2' : 'vqe_v1';
  const candidates = [
    path.join(DASHBOARD_ROOT, 'thirdparty', 'libs', runtimeName),
    path.join(HTML_ROOT, 'thirdparty', 'libs', runtimeName),
  ];
  for (const dir of candidates) {
    if (fs.existsSync(path.join(dir, 'librkaudio_vqe.so'))) return dir;
  }
  return '';
}

// rockaa_capt -Z 1 prints a final summary line
//   "== sed events: babycry:389 buzzer:0 glassbreaking:0, cost avg:372us =="
// and per-event lines "sed event - babycry: 1, buzzer: 0, ..." while running.
function parseSedEvents(output) {
  const text = String(output || '');
  const m = text.match(/sed events: babycry:(\d+) buzzer:(\d+) glassbreaking:(\d+)/);
  if (m) return { bcd: Number(m[1]), buz: Number(m[2]), gbs: Number(m[3]) };
  const events = text.match(/sed event - babycry: 1/g);
  return events ? { bcd: events.length, buz: 0, gbs: 0 } : null;
}

// The timestamp appended by rockaa is the end of a 256-sample (16 ms) frame.
// Convert each hit to its exact [start, end] interval and merge only adjacent
// frames; bridging longer gaps would falsely display inactive BCD samples.
function parseSedEventSpans(output) {
  const frameSec = 0.016;
  const toleranceSec = frameSec * 0.5;
  const re = /sed event - babycry: 1.*?t:\s*([\d.]+)s/g;
  const text = String(output || '');
  const spans = [];
  let m;
  while ((m = re.exec(text)) !== null) {
    const t1 = parseFloat(m[1]);
    if (!Number.isFinite(t1)) continue;
    const t0 = Math.max(0, t1 - frameSec);
    const last = spans[spans.length - 1];
    if (last && t0 - last.t1 <= toleranceSec) last.t1 = t1;
    else spans.push({ t0, t1 });
  }
  return spans;
}

// Offline SED cannot run on the host (NEON + NPU-only rknn models), so when a
// device is connected and a SED model is selected the offline run is executed
// on the device with the same rockaa_capt pipeline the online session uses.
async function runOfflineSimulationOnDevice(message) {
  const channel = String(message.channel || 'TX').toUpperCase();
  if (channel !== 'TX')
    throw new Error('device-side offline simulation with SED requires TX');
  const version = String(message.version || 'v2').toLowerCase();
  if (version !== 'v2')
    throw new Error('device-side offline simulation with SED requires a VQE v2 config');

  const target = await resolveOnlineDevice(message.device || {});
  const deviceId = target.adbDevice;
  const platform = await detectDevicePlatform(target);
  if (!platform.category)
    throw new Error(`unsupported device platform: ${platform.soc}`);
  const platformDir = findPlatformInstallDir(platform.category);
  if (!platformDir)
    throw new Error(`prebuilt platform not found: ${platform.category}`);

  const workspace = await selectOnlineWorkspace(target, deviceId);
  const channelConfig = onlineChannelConfig(channel, message.config, message.channelConfig);
  const conf = localConfigFile(channel, message.config);

  const runtime = await runtimePrefixForDevice(target, workspace, version);
  if (runtime.missingRequiredVqe)
    throw new Error(`Matching VQE ${version.toUpperCase()} runtime was not found on the device`);
  const missingModels = await checkOnlineModelFiles(target, message.config);
  if (missingModels.length)
    throw new Error(`model file(s) missing on device: ${missingModels.join(', ')}`);

  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rockaa_offline_dev_'));
  try {
    const inputPath = path.join(workDir, 'offline_input.wav');
    fs.writeFileSync(inputPath, Buffer.from(String(message.inputBase64 || ''), 'base64'));

    const pushNotes = [`[device-offline] runtime pushed to ${workspace}`];
    await runAdb(target, ['shell', `mkdir -p ${shellQuote(workspace)}`], { timeoutMs: 10000 });
    await runAdb(target, ['push', platformDir + path.sep + '.', workspace + '/'], { timeoutMs: 180000 });
    await runAdb(target, ['shell',
      `rm -rf ${shellQuote(`${workspace}/sed`)} ${shellQuote(`${workspace}/lib_sed`)}`],
    { timeoutMs: 10000 });
    await runAdb(target, ['push', conf.file, `${workspace}/${conf.name}`], { timeoutMs: 15000 });
    await runAdb(target, ['push', inputPath, `${workspace}/offline_input.wav`], { timeoutMs: 60000 });
    await runAdb(target, ['shell',
      `cd ${shellQuote(workspace)} && chmod +x utils/rockaa_capt utils/rockaa_play utils/rockaa_mix 2>/dev/null || true`],
    { timeoutMs: 10000 });

    const sedLibDir = path.join(platformDir, 'sed');
    if (!fs.existsSync(sedLibDir))
      throw new Error(`SED runtime is not bundled for platform ${platform.category} (missing sed/)`);
    const sedManual = !!(message.sedModel && message.sedModel.base64);
    const bundledModel = !sedManual && message.sedAuto === true
      ? bundledSedModelForPlatform(platformDir, platform) : null;
    if (!sedManual && !bundledModel)
      throw new Error(`SED model is not bundled for platform ${platform.buildPlatform}`);
    const modelBytes = sedManual
      ? Buffer.from(String(message.sedModel.base64 || ''), 'base64')
      : fs.readFileSync(bundledModel.file);
    if (!modelBytes.length || modelBytes.length > 64 * 1024 * 1024)
      throw new Error('invalid SED rknn model payload');
    if (modelBytes.length < 64 || modelBytes.subarray(0, 4).toString('ascii') !== 'RKNN')
      throw new Error('invalid SED rknn model header');
    const localModel = sedManual
      ? path.join(os.tmpdir(), `rockaa_html_sed_${process.pid}_${Date.now()}.rknn`)
      : bundledModel.file;
    if (sedManual) fs.writeFileSync(localModel, modelBytes);
    try {
      await runAdb(target, ['push', localModel, `${workspace}/sed_model.rknn`], { timeoutMs: 60000 });
    } finally {
      if (sedManual) fs.unlink(localModel, () => {});
    }
    // SED ships as one self-contained runtime set (detect + common + v2 VQE);
    // the device-side common ABI has to match the detect build.
    await runAdb(target, ['shell', `mkdir -p ${shellQuote(`${workspace}/lib_sed`)}`], { timeoutMs: 10000 });
    for (const lib of ['librkaudio_common.so', 'librkaudio_vqe.so', 'librkaudio_detect.so']) {
      const localLib = path.join(sedLibDir, lib);
      if (!fs.existsSync(localLib))
        throw new Error(`SED runtime library is missing: ${localLib}`);
      await runAdb(target, ['push', localLib, `${workspace}/lib_sed/${lib}`], { timeoutMs: 60000 });
    }

    const refChannels = Math.max(1, Number(message.refChannels) || 1);
    const cmd = `cd ${shellQuote(workspace)} && `
      + runtime.prefix
      + `export LD_LIBRARY_PATH=${shellQuote(`${workspace}/lib_sed`)}:$LD_LIBRARY_PATH; `
      + `export rockaa_vqe_v2_dir=${shellQuote(`${workspace}/lib_sed`)}; `
      + `export rockaa_sed_rknn_path=${shellQuote(`${workspace}/sed_model.rknn`)}; `
      + `./utils/rockaa_capt -I offline_input.wav --hal tinyalsa `
      + `-c ${channelConfig.inputChannels} -C ${refChannels} `
      + `-b 16 -r 16000 -p 256 -Z 1 -F ${shellQuote(conf.name)} -O offline_output.wav`;
    broadcastOnlineLog('TX', 'Device offline run: rockaa_capt start');
    const runResult = await runAdb(target, ['shell', cmd], { timeoutMs: 300000, maxOutput: 4 * 1024 * 1024 });
    const runLog = ((runResult.stdout || '') + (runResult.stderr || '')).trim();

    const localOut = path.join(workDir, 'offline_output.wav');
    await runAdb(target, ['pull', `${workspace}/offline_output.wav`, localOut], { timeoutMs: 60000 });
    await runAdbAllowFail(target, ['shell',
      `rm -f ${shellQuote(`${workspace}/offline_input.wav`)} ${shellQuote(`${workspace}/offline_output.wav`)}`],
    { timeoutMs: 10000 });
    if (!fs.existsSync(localOut))
      throw new Error(`device offline run produced no output: ${runLog.slice(-400)}`);

    broadcastOnlineLog('TX', 'Device offline run: finished');
    return {
      outputBase64: fs.readFileSync(localOut).toString('base64'),
      log: pushNotes.join('\n') + '\n' + runLog,
      sed: parseSedEvents(runLog),
      sedSpans: parseSedEventSpans(runLog),
      source: 'device',
    };
  } finally {
    fs.rm(workDir, { recursive: true, force: true }, () => {});
  }
}

async function runOfflineSimulation(message) {
  // Device-side offline run when SED is requested and a device is connected:
  // the SED runtime needs the device NPU and cannot execute on the host.
  if (message.device && (message.sedModel || message.sedAuto === true))
    return runOfflineSimulationOnDevice(message);

  const channel = String(message.channel || 'TX').toUpperCase();
  const version = String(message.version || 'v1').toLowerCase();
  const config = message.config;
  const inputBase64 = message.inputBase64;

  if (!config) throw new Error('offline.run requires a config object');
  if (!inputBase64) throw new Error('offline.run requires input audio data');

  const runtimeDir = findVqeRuntimeDir(version);
  if (!runtimeDir) throw new Error(`VQE runtime not found: ${version}`);

  const runner = channel === 'RX' ? 'vqe_ao_test' : 'vqe_ai_test';
  const runnerPath = path.join(runtimeDir, runner);
  if (!fs.existsSync(runnerPath))
    throw new Error(`VQE test binary not found: ${runnerPath}`);

  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rockaa_offline_'));
  try {
    const configName = channel === 'RX' ? 'config_aovqe.json' : 'config_aivqe.json';
    const configPath = path.join(workDir, configName);
    fs.writeFileSync(configPath, JSON.stringify(config, null, 2));

    const inputPath = path.join(workDir, 'input.wav');
    fs.writeFileSync(inputPath, Buffer.from(inputBase64, 'base64'));

    const outputPath = path.join(workDir, 'output.wav');

    const args = [inputPath, outputPath, configPath];
    if (channel !== 'RX' && message.refChannels)
      args.push(String(message.refChannels));

    const env = Object.assign({}, process.env);
    env.LD_LIBRARY_PATH = runtimeDir + ':' + (env.LD_LIBRARY_PATH || '');

    const child = childProcess.spawn(runnerPath, args, {
      cwd: workDir, env, shell: false,
    });
    const perfSampler = startOfflinePerfSampler(child.pid);

    let stdout = '', stderr = '';
    child.stdout.on('data', chunk => stdout += chunk.toString());
    child.stderr.on('data', chunk => stderr += chunk.toString());

    let exitCode = 0;
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => { child.kill(); reject(new Error(`${runner} timeout`)); }, 120000);
      child.on('error', err => { clearTimeout(timer); reject(err); });
      child.on('close', code => {
        clearTimeout(timer);
        exitCode = code;
        resolve();
      });
    });
    const perf = Object.assign(perfSampler.stop(), parseOfflineRtf(stdout + stderr) || {});
    if (exitCode !== 0)
      throw new Error(`${runner} exited with ${exitCode}: ${(stderr || stdout).trim()}`);

    if (!fs.existsSync(outputPath))
      throw new Error('VQE output WAV not generated');

    const outputBuffer = fs.readFileSync(outputPath);
    return {
      outputBase64: outputBuffer.toString('base64'),
      log: (stdout + stderr).trim(),
      perf,
    };
  } finally {
    fs.rm(workDir, { recursive: true, force: true }, () => {});
  }
}

async function dispatch(message) {
  const target = message.target || {};
  switch (message.cmd) {
  case 'bridge.info':
    return {
      version: VERSION,
      host: { platform: process.platform, arch: process.arch, release: os.release() },
      adbPath: findAdb(),
      capabilities: {
        adb: true,
        device: true,
        config: true,
        'config.history': true,
        'vqe.version.check': true,
        online: true,
        'online.tx': true,
        'online.rx': true,
        'online.rx.source': true,
        'online.rx.browser-record': true,
        'online.rx.browser-file': true,
        'online.playback': process.platform !== 'win32',
        'audio.capture': process.platform !== 'win32',
        pae: true,
        'pae.stop': true,
        codec: true,
        autotune: true,
        'effect.tuning': true,
      },
    };
  case 'config.list':
    return listJsonConfigs();
  case 'config.read':
    return readJsonConfig(message.path);
  case 'device.audio.info':
    return detectDeviceAudioInfo(target);
  case 'device.config.list':
    return listDeviceConfigs(target);
  case 'device.config.pull':
    return pullDeviceConfig(target, message.path);
  case 'effect.bin.push':
    return pushEffectBin(target, message.name, message.base64);
  case 'effect.bin.pull':
    return pullEffectBin(target, message.name);
  case 'vqe.version.check':
    return checkRemoteVqeVersion(message);
  case 'adb.devices':
    return adbDevices();
  case 'device.connect':
    return connectDevice(target);
  case 'device.disconnect':
    return disconnectDevice(target);
  case 'host.capture.devices':
    return { devices: hostCaptureDevices() };
  case 'params.apply':
    {
      const ch = String(message.channel || 'TX').toUpperCase();
      const newConfig = message.config;
      if (!newConfig)
        throw new Error('params.apply requires a config object');
      broadcastOnlineLog(ch, 'Applying updated parameters');
      return restartOnlineProcess(ch, newConfig);
    }
  case 'online.start':
    return startOnlineSession(message);
  case 'online.perf.interval':
    return setOnlinePerfInterval(message);
  case 'online.perf.toggle':
    return setOnlinePerfToggle(message);
  case 'online.playback':
    return setOnlinePlayback(message);
  case 'online.stop':
    return stopOnlineSession(message.channel || 'TX');
  case 'pae.start':
    return runProfessionalAcousticEvaluation(message);
  case 'pae.stop':
    return stopProfessionalAcousticEvaluation(message);
  case 'codec.cards':
    return getCodecCards(target);
  case 'codec.list':
    return getCodecControls(target, message.card);
  case 'codec.set':
    return setCodecControl(target, message.card, message.name, message.values);
  case 'autotune.subscribe':
    return {
      busy: autotuneBusy(),
      kind: autotuneSession.kind,
      startedAt: autotuneSession.startedAt,
      history: autotuneSession.history.slice(-50),
    };
  case 'autotune.eval.run': {
    if (autotuneBusy()) throw new Error(`autotune busy with ${autotuneSession.kind}`);
    const pre = await autotunePreflight();
    if (!pre.ok) throw new Error(pre.message);

    if (!fs.existsSync(AUTOTUNE_SO)) throw new Error(`VQE .so not found: ${AUTOTUNE_SO}`);

    const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rockaa_autotune_'));
    autotuneSession.kind = 'eval';
    autotuneSession.startedAt = Date.now();
    try {
      const inputPath = path.join(workDir, 'input.wav');
      fs.writeFileSync(inputPath, Buffer.from(message.wavBase64, 'base64'));
      const configPath = path.join(workDir, 'config.json');
      fs.writeFileSync(configPath, JSON.stringify(message.config));

      const args = [
        AUTOTUNE_CLI, 'evaluate',
        '--so-path', AUTOTUNE_SO,
        '--config', configPath,
        '--input', inputPath,
        '--num-mic', String(message.numMic || 2),
        '--num-ref', String(message.numRef || 0),
        '--sample-rate', String(message.sampleRate || 48000),
      ];
      if (message.noSpeechmos) args.push('--no-speechmos');

      return await autotuneRunToCompletion(args);  // { metrics, outputBase64 }
    } finally {
      autotuneChildDied();
      fs.rm(workDir, { recursive: true, force: true }, () => {});
    }
  }
  case 'autotune.tune.start': {
    if (autotuneBusy()) throw new Error(`autotune busy with ${autotuneSession.kind}`);
    const pre = await autotunePreflight();
    if (!pre.ok) throw new Error(pre.message);

    if (!fs.existsSync(AUTOTUNE_SO)) throw new Error(`VQE .so not found: ${AUTOTUNE_SO}`);

    const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rockaa_autotune_'));
    const inputPath = path.join(workDir, 'input.wav');
    fs.writeFileSync(inputPath, Buffer.from(message.wavBase64, 'base64'));
    const configPath = path.join(workDir, 'config.json');
    fs.writeFileSync(configPath, JSON.stringify(message.config));

    const args = [
      AUTOTUNE_CLI, 'tune',
      '--so-path', AUTOTUNE_SO,
      '--config', configPath,
      '--input', inputPath,
      '--modules', String(message.modules || 'aec'),
      '--trials', String(message.trials || 50),
      '--num-mic', String(message.numMic || 2),
      '--num-ref', String(message.numRef || 0),
      '--sample-rate', String(message.sampleRate || 48000),
      '--optimize-mode', String(message.optimizeMode || 'both'),
      '--aecmos-talk-type', String(message.talkType || 'dt'),
      '--max-iter', String(message.maxIter || 3),
    ];
    if (message.noSpeechmos) args.push('--no-speechmos');

    autotuneSession.kind = 'tune';
    autotuneSession.startedAt = Date.now();
    autotuneSession.workDir = workDir;  // for cleanup on close

    // Spawn but don't await — start returns immediately. Progress streams via broadcast.
    const child = childProcess.spawn(AUTOTUNE_PYTHON, args, { shell: false });
    autotuneSession.child = child;
    autotuneSession.pid = child.pid;

    let stdoutBuf = '';
    child.stdout.on('data', d => {
      stdoutBuf += d.toString();
      const lines = stdoutBuf.split('\n');
      stdoutBuf = lines.pop();  // keep partial last line
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const obj = JSON.parse(line);
          // Namespacize: "progress" -> "autotune.progress", "done" -> "autotune.done"
          const evt = Object.assign({ sessionId: autotuneSession.startedAt }, obj);
          evt.type = obj.type ? `autotune.${obj.type}` : 'autotune.line';
          autotuneBroadcast(evt);
        } catch (e) {
          autotuneBroadcast({ type: 'autotune.log', message: line });
        }
      }
    });
    child.stderr.on('data', d => {
      const msg = d.toString().trim();
      if (msg) autotuneBroadcast({ type: 'autotune.log', message: msg });
    });
    child.on('close', code => {
      autotuneBroadcast({
        type: 'autotune.closed',
        sessionId: autotuneSession.startedAt,
        code,
        clean: code === 0,
      });
      autotuneChildDied();
      fs.rm(workDir, { recursive: true, force: true }, () => {});
    });
    child.on('error', err => {
      autotuneBroadcast({ type: 'autotune.error', message: String(err) });
      autotuneChildDied();
      fs.rm(workDir, { recursive: true, force: true }, () => {});
    });

    return { ok: true, sessionId: autotuneSession.startedAt };
  }
  case 'autotune.tune.stop': {
    if (!autotuneBusy() || autotuneSession.kind !== 'tune') {
      return { ok: false, message: 'no tune running' };
    }
    // SIGINT lets Python finish current trial and emit done (Task 7 SIGINT handler)
    autotuneSession.child.kill('SIGINT');
    return { ok: true };
  }
  case 'autotune.hardware.cards': {
    // Probe /proc/asound/cards so the user can pick the right playback and
    // capture card indices without dropping to a shell.
    const target = await resolveOnlineDevice(message.target || {});
    const r = await runAdbAllowFail(target, ['shell', 'cat /proc/asound/cards'], { timeoutMs: 10000 });
    if (r.code !== 0) {
      throw new Error(`adb cat /proc/asound/cards failed: ${(r.stderr || '').trim() || r.code}`);
    }
    return { cards: String(r.stdout || '').trim() };
  }
  case 'autotune.hardware.collect': {
    // Auto-record a single standard signal via tinyplay+tinycap and return
    // the captured WAV as base64 so the browser can cache it for the final run.
    if (autotuneBusy()) throw new Error(`autotune busy with ${autotuneSession.kind}`);
    autotuneSession.busy = true;
    const pre = await autotunePreflight();
    if (!pre.ok) throw new Error(pre.message);
    const target = await resolveOnlineDevice(message.target || {});
    const workspace = await selectOnlineWorkspace(target, target.deviceId);
    const probe = await probeTinyBinaries(target);
    if (!probe.tinyplay || !probe.tinycap) {
      throw new Error(`device missing tinyplay/tinycap (${probe.raw}); use import mode`);
    }
    autotuneSession.kind = 'hardware';
    autotuneSession.startedAt = Date.now();
    try {
      const sig = String(message.signal || '');
      if (!HW_SIGNAL_GEN_TEST[sig] && sig !== 'silence') {
        throw new Error(`unsupported signal: ${sig}`);
      }
      if (sig === 'whitenoise_sealed') {
        throw new Error('whitenoise_sealed is import-only; cannot auto-collect');
      }
      const r = await collectHardwareSignal(sig, target, workspace, message);
      return { type: 'done', signal: sig, wavBase64: r.wavBase64, sizeBytes: r.wavBase64.length * 3 / 4 | 0 };
    } finally {
      autotuneChildDied();
    }
  }
  case 'autotune.hardware.run': {
    // Full H1-H10 acceptance run. Browser sends signalBase64 for any signals
    // it has imported and autoCollect for any it wants the bridge to record.
    return await runHardwareAcceptance(message);
  }
  case 'offline.run':
    return runOfflineSimulation(message);
  default:
    throw new Error(`unknown command: ${message.cmd || ''}`);
  }
}

function safeStaticPath(requestPath) {
  const decoded = decodeURIComponent(requestPath.split('?')[0]);
  const rel = decoded === '/' ? 'index.html' : decoded.replace(/^\/+/, '');
  const full = path.resolve(HTML_ROOT, rel);
  if (!full.startsWith(HTML_ROOT + path.sep) && full !== HTML_ROOT)
    return '';
  return full;
}

function handleBridgeLifecycle(req, res, parsed) {
  const pathname = parsed.pathname || '/';
  if (pathname === '/__bridge/alive') {
    cancelScheduledShutdown();
    res.writeHead(204, { 'Cache-Control': 'no-cache' });
    res.end();
    return true;
  }
  if (pathname === '/__bridge/shutdown') {
    res.writeHead(204, { 'Cache-Control': 'no-cache' });
    res.end();
    if (onlineSessions.size > 0) return true;
    const query = new URLSearchParams(parsed.query || '');
    scheduleShutdown(query.get('reason') || 'browser tab closed', 1200);
    return true;
  }
  return false;
}

function serveStatic(req, res) {
  const parsed = url.parse(req.url || '/');
  if (handleBridgeLifecycle(req, res, parsed)) return;
  const filePath = safeStaticPath(parsed.pathname || '/');
  if (!filePath) {
    res.writeHead(403);
    res.end('forbidden');
    return;
  }
  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(err.code === 'ENOENT' ? 404 : 500);
      res.end(err.code === 'ENOENT' ? 'not found' : err.message);
      return;
    }
    res.writeHead(200, {
      'Content-Type': MIME_TYPES[path.extname(filePath)] || 'application/octet-stream',
      'Cache-Control': 'no-cache, no-store, must-revalidate',
      'Pragma': 'no-cache',
      'Expires': '0',
    });
    res.end(data);
  });
}

function websocketAccept(key) {
  return crypto.createHash('sha1')
    .update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11')
    .digest('base64');
}

function encodeFrame(text) {
  const payload = Buffer.from(text);
  const len = payload.length;
  if (len < 126) {
    return Buffer.concat([Buffer.from([0x81, len]), payload]);
  }
  if (len <= 0xffff) {
    const head = Buffer.alloc(4);
    head[0] = 0x81;
    head[1] = 126;
    head.writeUInt16BE(len, 2);
    return Buffer.concat([head, payload]);
  }
  const head = Buffer.alloc(10);
  head[0] = 0x81;
  head[1] = 127;
  head.writeBigUInt64BE(BigInt(len), 2);
  return Buffer.concat([head, payload]);
}

function sendJson(socket, body) {
  if (!socket.destroyed) socket.write(encodeFrame(JSON.stringify(body)));
}

function decodeFrames(state, chunk, onMessage, socket) {
  state.buffer = Buffer.concat([state.buffer, chunk]);
  while (state.buffer.length >= 2) {
    const first = state.buffer[0];
    const second = state.buffer[1];
    const fin = (first & 0x80) !== 0;
    const opcode = first & 0x0f;
    const masked = (second & 0x80) !== 0;
    let len = second & 0x7f;
    let offset = 2;
    if (len === 126) {
      if (state.buffer.length < offset + 2) return;
      len = state.buffer.readUInt16BE(offset);
      offset += 2;
    } else if (len === 127) {
      if (state.buffer.length < offset + 8) return;
      len = Number(state.buffer.readBigUInt64BE(offset));
      offset += 8;
    }
    if (!masked) {
      socket.destroy();
      return;
    }
    if (state.buffer.length < offset + 4 + len) return;
    const mask = state.buffer.subarray(offset, offset + 4);
    offset += 4;
    const payload = Buffer.alloc(len);
    for (let i = 0; i < len; i++)
      payload[i] = state.buffer[offset + i] ^ mask[i % 4];
    state.buffer = state.buffer.subarray(offset + len);
    if (opcode === 0x8) {
      socket.end(Buffer.from([0x88, 0x00]));
      return;
    }
    if (opcode === 0x9) {
      socket.write(Buffer.concat([Buffer.from([0x8a, payload.length]), payload]));
      continue;
    }
    if (opcode === 0x1) {
      if (fin) {
        onMessage(payload.toString('utf8'));
      } else {
        state.fragmentOpcode = opcode;
        state.fragments = [payload];
      }
      continue;
    }
    if (opcode === 0x0) {
      if (!state.fragments || !state.fragments.length) {
        socket.destroy();
        return;
      }
      state.fragments.push(payload);
      if (fin) {
        const message = Buffer.concat(state.fragments);
        const fragmentOpcode = state.fragmentOpcode;
        state.fragments = [];
        state.fragmentOpcode = 0;
        if (fragmentOpcode === 0x1) onMessage(message.toString('utf8'));
      }
    }
  }
}

function attachWebSocket(req, socket) {
  const key = req.headers['sec-websocket-key'];
  if (!key) {
    socket.destroy();
    return;
  }
  socket.write([
    'HTTP/1.1 101 Switching Protocols',
    'Upgrade: websocket',
    'Connection: Upgrade',
    `Sec-WebSocket-Accept: ${websocketAccept(key)}`,
    '',
    '',
  ].join('\r\n'));

  clients.add(socket);
  const frameState = { buffer: Buffer.alloc(0), fragments: [], fragmentOpcode: 0 };
  socket.on('data', chunk => {
    decodeFrames(frameState, chunk, async text => {
      let request = null;
      try {
        request = JSON.parse(text);
        if (request.cmd === 'online.stream.attach') {
          attachOnlineStream(socket, request);
          return;
        }
        if (request.cmd === 'online.source.write') {
          writeBrowserRecordSource(socket, request);
          return;
        }
        if (request.cmd === 'online.source.file.write') {
          const result = await writeBrowserFileSource(socket, request);
          sendJson(socket, { id: request.id, ok: true, result });
          return;
        }
        if (request.cmd === 'online.source.file.end') {
          const result = finishBrowserFileSource(socket, request);
          sendJson(socket, { id: request.id, ok: true, result });
          return;
        }
        if (request.cmd === 'autotune.subscribe') {
          autotuneSession.clients.add(socket);
          // Fall through to dispatch — dispatch returns the state reply.
        }
        const result = await dispatch(request);
        sendJson(socket, { id: request.id, ok: true, result });
      } catch (err) {
        sendJson(socket, {
          id: request && request.id,
          ok: false,
          error: err.message || String(err),
        });
      }
    }, socket);
  });
  socket.on('close', () => {
    clients.delete(socket);
    autotuneSession.clients.delete(socket);
  });
  socket.on('error', () => {
    clients.delete(socket);
    autotuneSession.clients.delete(socket);
  });
}

const server = http.createServer(serveStatic);
server.on('upgrade', attachWebSocket);
let listenAttempt = 0;
if (STOP_REQUESTED) {
  requestBridgeShutdown();
} else {
  startBridgeServer(bridgePort);
}

function startBridgeServer(port) {
  const attempt = ++listenAttempt;
  server.once('error', err => {
    if (attempt !== listenAttempt) return;
    if (err && err.code === 'EADDRINUSE' && AUTO_PORT && port < MAX_AUTO_PORT) {
      const nextPort = port + 1;
      console.warn(`Bridge port ${HOST}:${port} is in use; trying ${nextPort}.`);
      bridgePort = nextPort;
      startBridgeServer(nextPort);
      return;
    }
    console.error(`Bridge failed to listen on ${HOST}:${port}: ${err.message}`);
    process.exitCode = 1;
    setImmediate(() => process.exit(1));
  });
  server.listen(port, HOST, () => {
    if (attempt !== listenAttempt) return;
    const adb = findAdb() || 'not found';
    const dashboardUrl = `http://${HOST}:${port}/`;
    console.log(`RockAA HTML ADB Bridge ${VERSION}`);
    if (port !== REQUESTED_PORT)
      console.log(`Requested port:    ${REQUESTED_PORT} (busy, using ${port})`);
    console.log(`Serving dashboard: ${dashboardUrl}`);
    console.log(`WebSocket bridge:  ws://${HOST}:${port}/`);
    console.log(`Host platform:     ${process.platform}/${process.arch}`);
    console.log(`ADB path:          ${adb}`);
    startAdbDeviceTracker();
    openBrowser(dashboardUrl);
  });
}

async function shutdown(reason) {
  if (shuttingDown) return;
  shuttingDown = true;
  cancelScheduledShutdown();
  if (reason) console.log(`Shutting down: ${reason}`);
  for (const channel of [...onlineSessions.keys()])
    await stopOnlineSession(channel);
  for (const client of clients) client.destroy();
  server.close(() => process.exit(0));
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('exit', code => {
  console.log(`Bridge process exit: ${code}`);
});
process.on('uncaughtException', err => {
  console.error(`Uncaught exception: ${err && err.stack ? err.stack : err}`);
});
process.on('unhandledRejection', err => {
  console.error(`Unhandled rejection: ${err && err.stack ? err.stack : err}`);
});
