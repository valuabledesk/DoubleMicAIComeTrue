/* ================================================================
   Auto Tuning dialog — bridge WebSocket consumer
   =================================================================
   Three-tab dialog (Hardware / Eval / Tune) that drives the Python
   autotune CLI via the bridge. Tab-specific logic lands in tasks 19-21;
   this file owns the dialog lifecycle, tab switching, the busy mutex,
   and the bridge subscribe/push-message pipeline. */

// ── state ──
const autotuneState = {
  overlay: null,
  tabs: { hw: null, eval: null, tune: null },
  subscribed: false,
  busy: false,
  busyKind: '',
  // Whether each tab's Start button is startable independent of the busy mutex.
  // Tabs that need a WAV stay false until a file is imported; the hardware tab
  // has no such requirement so it's true from the start.
  startable: { hw: true, eval: false, tune: false },
  wiredTabs: false,
  wiredClose: false,
  wiredEval: false,
  wiredTune: false,
  wiredHw: false,
  // Phase tracker for two-phase tune runs. Resets to null on each Start so
  // the next run re-emits the "Phase 1: Rules iteration" header.
  lastPhase: null,
};

// ── device-channel derivation ──
// rkaudio_preprocess_init_by_conf(rate, bits, src_chan, ref_chan, conf_path)
// refuses mismatched channel counts (returns NULL → "Failed to initialize VQE
// processor"), so the mic/ref counts passed to the CLI must match the config.
// The dashboard already tracks these in state.deviceSettings; fall back to
// sensible defaults only when the user hasn't configured them.
function autotuneChannelParams(channel) {
  const ds = (typeof state !== 'undefined' && state.deviceSettings && state.deviceSettings[channel]) || {};
  return {
    numMic: ds.micChannels || 2,
    numRef: ds.refChannels || 0,
    sampleRate: ds.sampleRate || 48000,
  };
}

// ── bridge send wrapper ──
// sendBridgeCommand is defined in bridge-client.js; resolves with the
// `result` field, rejects on error/timeout. Tune.start returns fast
// (fire-and-stream); use a generous timeout for eval.run and hardware.run
// since those block until the CLI exits.
function autotuneSend(cmd, params = {}, timeoutMs) {
  if (typeof sendBridgeCommand !== 'function') {
    return Promise.reject(new Error('bridge client not available'));
  }
  return sendBridgeCommand(cmd, params, timeoutMs);
}

// ── subscribe on dialog open ──
async function autotuneSubscribe() {
  if (autotuneState.subscribed) return;
  try {
    const r = await autotuneSend('autotune.subscribe', {}, 5000) || {};
    autotuneState.busy = !!r.busy;
    autotuneState.busyKind = r.kind || '';
    // If a tune/hardware run was in progress when the bridge restarted
    // (e.g. user reopened the dialog), flag it: the backend may still be
    // running but we won't get its progress events.
    if (autotuneState.busy) {
      autotuneWarn(t('autotune_session_lost'));
    }
    // Replay recent history (cap 50 server-side) so the UI shows recent activity.
    for (const m of (r.history || [])) handleAutotuneMessage(m);
    autotuneState.subscribed = true;
  } catch (err) {
    autotuneWarn(t('bridge_disconnected') + ': ' + (err.message || err));
  }
}

// ── push message dispatch ──
// Called by bridge-client.js setupBridgeSocket for any msg.type starting
// with "autotune.". Tab-specific handlers (tasks 19-21) attach below.
function handleAutotuneMessage(msg) {
  switch (msg.type) {
    case 'autotune.progress':
      if (typeof autotuneTuneOnProgress === 'function') autotuneTuneOnProgress(msg);
      break;
    case 'autotune.done':
      if (typeof autotuneTuneOnDone === 'function') autotuneTuneOnDone(msg);
      break;
    case 'autotune.error':
      autotuneOnError(msg.message || 'unknown error');
      break;
    case 'autotune.hw.progress':
      if (typeof autotuneHwOnProgress === 'function') autotuneHwOnProgress(msg);
      break;
    case 'autotune.closed':
      autotuneOnClosed(msg);
      break;
    case 'autotune.log':
    case 'autotune.line':
      console.log('[autotune]', msg.message || msg);
      autotuneAppendLog(msg.message || '');
      break;
  }
  autotuneUpdateButtonStates();
}

// ── stubs (filled in tasks 19-21) ──
function autotuneOnClosed(_msg) {
  // Backend process exited. If we thought it was busy, clear the mutex
  // (cooperative stop also lands here).
  autotuneState.busy = false;
  autotuneState.busyKind = '';
}

function autotuneWarn(msg) {
  // For now, route to the global log panel. Task 19+ can add a dedicated
  // dialog status area if needed.
  if (typeof log === 'function') log('[AutoTune] ' + msg);
  else console.warn('[AutoTune]', msg);
}

function autotuneAppendLog(line) {
  // stderr from the CLI (logger.warning etc.) is forwarded by the bridge as
  // autotune.log events. Without this, VQE trial errors vanish into the
  // browser dev console where nobody looks. Route to the busy tab's log panel.
  if (!line) return;
  const tabKey = autotuneState.busyKind === 'hardware' ? 'hw' : autotuneState.busyKind;
  const tab = tabKey && autotuneState.tabs[tabKey];
  const el = tab && tab.querySelector('.autotune-log');
  if (!el) return;
  el.textContent += line + '\n';
  el.scrollTop = el.scrollHeight;
}

function autotuneOnError(msg) {
  autotuneWarn(msg);
  // Errors terminate whatever was running.
  autotuneState.busy = false;
  autotuneState.busyKind = '';
}

// ── mutex: disable Start across all tabs when busy ──
function autotuneUpdateButtonStates() {
  for (const tabKey of Object.keys(autotuneState.tabs)) {
    const tab = autotuneState.tabs[tabKey];
    if (!tab) continue;
    const startBtns = tab.querySelectorAll('.autotune-start');
    const stopBtns = tab.querySelectorAll('.autotune-stop');
    // A Start button is enabled only when (a) no autotune op is running AND
    // (b) the tab's own readiness flag is set (e.g., WAV imported).
    const startable = !autotuneState.busy && (autotuneState.startable[tabKey] !== false);
    startBtns.forEach(b => { b.disabled = !startable; });
    stopBtns.forEach(b => { b.disabled = !autotuneState.busy; });
  }
}

// ── view open/close ──
function openAutotuneDialog() {
  const overlay = document.getElementById('autotuneShell');
  if (!overlay) return;
  autotuneState.overlay = overlay;
  autotuneState.tabs.hw = overlay.querySelector('[data-panel="hw"]');
  autotuneState.tabs.eval = overlay.querySelector('[data-panel="eval"]');
  autotuneState.tabs.tune = overlay.querySelector('[data-panel="tune"]');
  autotuneWireTabs();
  autotuneWireClose();
  // Wire functions self-guard against re-calls (openAutotuneDialog is re-entrant).
  if (typeof autotuneEvalWire === 'function') autotuneEvalWire();
  if (typeof autotuneTuneWire === 'function') autotuneTuneWire();
  if (typeof autotuneHwWire === 'function') autotuneHwWire();
  const main = document.getElementById('mainShell');
  if (main) main.hidden = true;
  overlay.hidden = false;
  autotuneSetActiveNav();
  autotuneUpdateButtonStates();
  autotuneRefreshCfgStatus();
  autotuneSubscribe();
}

function autotuneSetActiveNav() {
  document.querySelectorAll('.nav-item').forEach(n => n.classList.remove('active'));
  const at = document.querySelector('.nav-item[data-page="autotune"]');
  if (at) at.classList.add('active');
}

// ── "current config" indicator on tune tab ──
// Tune (and eval/hw) all read state.config[currentChannel]; without an
// indicator the user can't tell which config they're tuning against, or
// why Start refuses to fire (autotuneWarn(t('no_config')) fires elsewhere).
// Refresh on dialog open, on tab switch to tune, and after Apply writes
// a new best_config back into state.config.
function autotuneRefreshCfgStatus() {
  const tunePanel = autotuneState.tabs && autotuneState.tabs.tune;
  if (!tunePanel) return;
  const indicator = tunePanel.querySelector('.autotune-cfg-status');
  if (!indicator) return;
  const ch = (typeof currentChannel === 'string') ? currentChannel : 'tx';
  // Per-run file override wins over the global state.config for display purposes.
  // Make it obvious which config the next Start will actually use.
  if (autotuneTuneConfig) {
    indicator.classList.toggle('empty', false);
    indicator.textContent = `${t('autotune_current_config')}: ${ch.toUpperCase()} → ${autotuneTuneConfigName} (${t('autotune_override')})`;
    autotuneSyncChannelInputs();
    return;
  }
  const cfg = (typeof state !== 'undefined' && state.config && state.config[ch]);
  const version = (cfg && typeof state !== 'undefined' && state.configVersion && state.configVersion[ch]) || '';
  indicator.classList.toggle('empty', !cfg);
  if (!cfg) {
    indicator.textContent = `${t('autotune_current_config')}: ${ch.toUpperCase()} — ${t('autotune_cfg_missing')}`;
  } else {
    indicator.textContent = `${t('autotune_current_config')}: ${ch.toUpperCase()} | ${version || 'config'}`;
  }
  autotuneSyncChannelInputs();
}

// Pre-populate MIC / Ref channel inputs from deviceSettings so the user sees
// (and can override) what will be passed to the CLI. Without this, the inputs
// fall back to their HTML default (mic=2, ref=1) which may not match the
// imported config — and ref=0 with AEC modules causes silent trial failure
// (the SDK init returns NULL when AES has no reference channel).
function autotuneSyncChannelInputs() {
  const tunePanel = autotuneState.tabs && autotuneState.tabs.tune;
  if (!tunePanel) return;
  const ch = (typeof currentChannel === 'string') ? currentChannel : 'tx';
  const params = autotuneChannelParams(ch);
  const mic = tunePanel.querySelector('.autotune-mic-ch');
  const ref = tunePanel.querySelector('.autotune-ref-ch');
  if (mic) mic.value = params.numMic;
  if (ref) ref.value = params.numRef;
}

function closeAutotuneDialog() {
  // No-op if autotune view was never opened. Called on every non-autotune nav
  // click, so bail out early to avoid running the hidden-swap / nav-reset
  // logic when there's nothing to clean up.
  if (!autotuneState.overlay) return;
  autotuneState.overlay.hidden = true;
  const main = document.getElementById('mainShell');
  if (main) main.hidden = false;
  // If closed via the topbar Close button (not a nav click), the autotune nav
  // item is still marked active. Clear it and default back to VQE tuning so the
  // sidebar matches where the user actually is. If a different nav item was
  // already clicked to leave autotune, that item is active — leave it alone.
  const atNav = document.querySelector('.nav-item[data-page="autotune"]');
  if (atNav) atNav.classList.remove('active');
  if (!document.querySelector('.nav-item.active[data-page]')) {
    const tuning = document.querySelector('.nav-item[data-page="tuning"]');
    if (tuning) tuning.classList.add('active');
  }
}

function autotuneWireTabs() {
  if (autotuneState.wiredTabs) return;
  autotuneState.wiredTabs = true;
  const btns = autotuneState.overlay.querySelectorAll('.tab-btn');
  btns.forEach(btn => {
    btn.addEventListener('click', () => {
      btns.forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      const target = btn.dataset.tab;
      autotuneState.overlay.querySelectorAll('.tab-panel').forEach(p => {
        p.hidden = p.dataset.panel !== target;
      });
      if (target === 'tune' && typeof autotuneRefreshCfgStatus === 'function') {
        autotuneRefreshCfgStatus();
      }
    });
  });
}

function autotuneWireClose() {
  if (autotuneState.wiredClose) return;
  autotuneState.wiredClose = true;
  const closeBtn = autotuneState.overlay.querySelector('.autotune-close');
  if (closeBtn) closeBtn.addEventListener('click', closeAutotuneDialog);
}

// ── Tab 2: Eval ────────────────────────────────────────────────────
let autotuneEvalWavBase64 = '';
// Optional per-run config override for the eval tab. When null, eval falls
// back to state.config[currentChannel]. Set by picking a JSON file
// (e.g. best_config.json exported from a prior tune run).
let autotuneEvalConfig = null;
let autotuneEvalConfigName = '';

function autotuneEvalWire() {
  if (autotuneState.wiredEval) return;
  autotuneState.wiredEval = true;
  const tab = autotuneState.tabs.eval;
  if (!tab) return;
  const fileInput = tab.querySelector('.autotune-eval-file');
  const cfgInput = tab.querySelector('.autotune-eval-config-file');
  const startBtn = tab.querySelector('[data-cmd="eval.run"]');
  if (fileInput) {
    fileInput.addEventListener('change', async (e) => {
      const f = e.target.files && e.target.files[0];
      if (!f) return;
      try {
        const buf = await f.arrayBuffer();
        // btoa expects a binary string; chunk to avoid call-stack limits on large files.
        const bytes = new Uint8Array(buf);
        let bin = '';
        const CHUNK = 0x8000;
        for (let i = 0; i < bytes.length; i += CHUNK) {
          bin += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
        }
        autotuneEvalWavBase64 = btoa(bin);
        autotuneState.startable.eval = true;
        autotuneUpdateButtonStates();
      } catch (err) {
        autotuneOnError('failed to read WAV: ' + (err.message || err));
      }
    });
  }
  if (cfgInput) {
    cfgInput.addEventListener('change', async (e) => {
      const f = e.target.files && e.target.files[0];
      const status = tab.querySelector('.autotune-eval-config-status');
      if (!f) {
        autotuneEvalConfig = null;
        autotuneEvalConfigName = '';
        if (status) status.textContent = '';
        return;
      }
      try {
        const text = await f.text();
        const parsed = JSON.parse(text);
        autotuneEvalConfig = parsed;
        autotuneEvalConfigName = f.name;
        if (status) status.textContent = '✓ ' + f.name;
      } catch (err) {
        autotuneEvalConfig = null;
        autotuneEvalConfigName = '';
        if (status) status.textContent = '✗ ' + (err.message || err);
        autotuneOnError('failed to read config JSON: ' + (err.message || err));
      }
    });
  }
  if (startBtn) startBtn.addEventListener('click', autotuneEvalRun);
}

async function autotuneEvalRun() {
  if (autotuneState.busy) {
    autotuneWarn(t('autotune_busy').replace('{kind}', autotuneState.busyKind));
    return;
  }
  if (!autotuneEvalWavBase64) {
    autotuneWarn(t('autotune_wav_empty'));
    return;
  }
  const tab = autotuneState.tabs.eval;
  const noSpeechmosCb = tab.querySelector('.autotune-eval-no-speechmos');
  const noSpeechmos = noSpeechmosCb ? noSpeechmosCb.checked : false;
  // The VQE .so requires a real config (it dereferences nested aec/aes/anr/agc
  // objects at init). A stub like {skv_configs:{version:'v1.0'}} segfaults the
  // C library, surfacing as a SIGSEGV that the Python wrapper can't catch.
  // Refuse the run instead of falling back to a broken stub.
  // Prefer the per-run override (e.g. best_config.json from a prior tune) so
  // the user can eval a saved config without first importing it as the
  // dashboard's "current config".
  const cfg = autotuneEvalConfig
    || (typeof state !== 'undefined' && state.config && state.config[currentChannel]);
  if (!cfg) {
    autotuneWarn(t('no_config'));
    return;
  }
  autotuneState.busy = true;
  autotuneState.busyKind = 'eval';
  autotuneUpdateButtonStates();
  // Show running indicator in the summary banner while the eval is in flight
  const banner = tab.querySelector('.eval-summary-banner');
  if (banner) {
    banner.hidden = false;
    banner.className = 'eval-summary-banner';
    banner.textContent = t('autotune_eval_running');
  }
  const tableEl = tab.querySelector('.eval-metrics-table');
  if (tableEl) tableEl.hidden = true;
  try {
    const r = await autotuneSend('autotune.eval.run', Object.assign({
      wavBase64: autotuneEvalWavBase64,
      config: cfg,
      noSpeechmos,
    }, autotuneChannelParams(currentChannel)), 120000);
    autotuneEvalRender(r && r.metrics, r && r.verdicts, r && r.thresholds, r && r.outputBase64);
  } catch (err) {
    autotuneOnError(String((err && err.message) || err));
  } finally {
    autotuneState.busy = false;
    autotuneState.busyKind = '';
    autotuneUpdateButtonStates();
  }
}

function autotuneEvalRender(metrics, verdicts, thresholds, outputBase64) {
  const tab = autotuneState.tabs.eval;
  if (!tab) return;

  // ── table rows ──
  const tbody = tab.querySelector('.eval-metrics-table tbody');
  const table = tab.querySelector('.eval-metrics-table');
  if (tbody && table) {
    tbody.innerHTML = '';
    const order = [
      'composite', 'echo_suppression', 'speech_preservation_nearend',
      'erle_farend_db', 'speech_preservation',
      'aecmos_echo', 'aecmos_deg', 'dnsmos_ovrl',
      'dnsmos_sig', 'dnsmos_bak', 'noise_floor', 'spectral_balance',
      'agc_consistency', 'clipping',
    ];
    const VERDICT_PRIORITY = { ERROR: 0, FAIL: 1, WARNING: 2, SKIP: 3, PASS: 4 };
    const VERDICT_TEXT = { PASS: '✓ PASS', WARNING: '△ WARN', FAIL: '✗ FAIL', ERROR: '✗ ERROR', SKIP: '— SKIP' };

    const keys = Object.keys(metrics || {});
    keys.sort((a, b) => {
      const pa = VERDICT_PRIORITY[verdicts && verdicts[a]] || 99;
      const pb = VERDICT_PRIORITY[verdicts && verdicts[b]] || 99;
      if (pa !== pb) return pa - pb;
      const ia = order.indexOf(a);
      const ib = order.indexOf(b);
      if (ia !== ib) {
        if (ia === -1) return 1;
        if (ib === -1) return -1;
        return ia - ib;
      }
      return a.localeCompare(b);
    });

    const fmtValue = (key, v) => {
      if (v === null || v === undefined || Number.isNaN(v)) return null;
      const suffix = key.endsWith('_db') ? ' dB' : '';
      return (typeof v === 'number' ? v.toFixed(3) : String(v)) + suffix;
    };
    const fmtThreshold = (key) => {
      const th = thresholds && thresholds[key];
      if (!th || typeof th.pass !== 'number') return '—';
      const suffix = key.endsWith('_db') ? ' dB' : '';
      return '≥' + th.pass + suffix;
    };

    for (const key of keys) {
      const tr = document.createElement('tr');
      const v = metrics[key];
      const st = verdicts && verdicts[key];
      const rowStatus = st ? String(st).toLowerCase() : 'skip';
      tr.classList.add('status-' + rowStatus);

      const nameTd = document.createElement('td');
      const labelKey = 'metric_label_' + key;
      const labelText = t(labelKey);
      nameTd.textContent = labelText !== labelKey ? labelText : key;
      const desc = t('metric_' + key);
      if (desc && desc !== 'metric_' + key) nameTd.title = desc;
      tr.appendChild(nameTd);

      const valTd = document.createElement('td');
      const formatted = fmtValue(key, v);
      valTd.textContent = formatted === null ? '—' : formatted;
      tr.appendChild(valTd);

      const thTd = document.createElement('td');
      thTd.textContent = fmtThreshold(key);
      tr.appendChild(thTd);

      const verdictTd = document.createElement('td');
      verdictTd.textContent = (st && VERDICT_TEXT[st]) || '—';
      tr.appendChild(verdictTd);

      tbody.appendChild(tr);
    }
    table.hidden = keys.length === 0;
  }

  // ── summary banner ──
  const banner = tab.querySelector('.eval-summary-banner');
  if (banner) {
    const counts = { PASS: 0, WARNING: 0, FAIL: 0, ERROR: 0, SKIP: 0 };
    let worst = null;
    const PRIORITY = { ERROR: 0, FAIL: 1, WARNING: 2, SKIP: 3, PASS: 4 };
    for (const k of Object.keys(metrics || {})) {
      const st = verdicts && verdicts[k];
      if (!st || !(st in counts)) continue;
      counts[st]++;
      if (worst === null || PRIORITY[st] < PRIORITY[worst]) worst = st;
    }
    if (worst === null) {
      banner.hidden = true;
    } else {
      const templateKey =
        worst === 'PASS' ? 'eval_summary_pass' :
        worst === 'FAIL' || worst === 'ERROR' ? 'eval_summary_fail' :
        'eval_summary_warn';
      let text = t(templateKey)
        .replace('{pass}', counts.PASS)
        .replace('{warn}', counts.WARNING + counts.FAIL + counts.ERROR)
        .replace('{fail}', counts.FAIL + counts.ERROR);
      if (counts.SKIP > 0) {
        text += ' ' + t('eval_summary_skip').replace('{skip}', counts.SKIP);
      }
      banner.textContent = text;
      banner.className = 'eval-summary-banner status-' + worst.toLowerCase();
      banner.hidden = false;
    }
  }

  if (outputBase64) {
    try {
      autotuneEvalDrawWaveform(tab.querySelector('.output-waveform'), outputBase64);
    } catch (err) {
      console.warn('[autotune] waveform draw failed:', err);
    }
  }
}

// Decode a 16-bit PCM mono WAV (base64) and draw a simple peak-style waveform.
// We don't reuse WaveformRenderer — that's tuned for live streaming with
// zoom/pan. A flat overview is enough here.
function autotuneEvalDrawWaveform(canvas, wavBase64) {
  if (!canvas) return;
  const ctx = canvas.getContext('2d');
  const bytes = Uint8Array.from(atob(wavBase64), c => c.charCodeAt(0));
  // Parse RIFF/WAVE: locate the "data" chunk (search; trust fmt is 16-bit PCM).
  if (bytes.length < 44 || bytes[0] !== 0x52 || bytes[1] !== 0x49
      || bytes[2] !== 0x46 || bytes[3] !== 0x46) {
    return; // not a RIFF file
  }
  let dataOffset = -1, dataLen = 0;
  let offset = 12;
  const view = new DataView(bytes.buffer);
  while (offset + 8 <= bytes.length) {
    const cid = String.fromCharCode(bytes[offset], bytes[offset+1], bytes[offset+2], bytes[offset+3]);
    const csize = view.getUint32(offset + 4, true);
    if (cid === 'data') { dataOffset = offset + 8; dataLen = csize; break; }
    offset += 8 + csize;
  }
  if (dataOffset < 0) return;
  const numSamples = Math.floor(dataLen / 2);
  if (numSamples <= 0) return;

  const w = canvas.width, h = canvas.height;
  ctx.fillStyle = '#111';
  ctx.fillRect(0, 0, w, h);
  ctx.strokeStyle = '#36c57e';
  ctx.lineWidth = 1;
  const mid = h / 2;
  const buckets = Math.min(numSamples, w * 2);
  const samplesPerBucket = Math.max(1, Math.floor(numSamples / buckets));
  ctx.beginPath();
  ctx.moveTo(0, mid);
  for (let i = 0; i < buckets; i++) {
    let peak = 0;
    const start = dataOffset + i * samplesPerBucket * 2;
    for (let j = 0; j < samplesPerBucket; j++) {
      const o = start + j * 2;
      if (o + 1 >= bytes.length) break;
      const s = view.getInt16(o, true) / 32768;
      if (Math.abs(s) > peak) peak = Math.abs(s);
    }
    const x = (i / buckets) * w;
    const y = mid - peak * (h / 2 - 2);
    ctx.lineTo(x, y);
    ctx.lineTo(x, mid + peak * (h / 2 - 2));
  }
  ctx.stroke();
}

// ── Tab 3: Tune ────────────────────────────────────────────────────
let autotuneTuneWavBase64 = '';
let autotuneTuneWavSampleRate = 0;
// Optional per-run config override for the tune tab. When null, tune falls
// back to state.config[currentChannel]. Set by picking a JSON file
// (e.g. a config saved from a prior run, or a known-good baseline).
let autotuneTuneConfig = null;
let autotuneTuneConfigName = '';

function autotuneTuneWire() {
  if (autotuneState.wiredTune) return;
  autotuneState.wiredTune = true;
  const tab = autotuneState.tabs.tune;
  if (!tab) return;
  const fileInput = tab.querySelector('.autotune-tune-file');
  const startBtn = tab.querySelector('[data-cmd="tune.start"]');
  const stopBtn = tab.querySelector('[data-cmd="tune.stop"]');
  // Mode → max-iter coupling: Bayesian-only mode skips Phase 1, so the
  // "rules iterations" input is meaningless in that mode. Disable + dim it
  // so the user gets immediate feedback that it won't be used.
  const modeSel = tab.querySelector('.autotune-optimize-mode');
  const maxIterInput = tab.querySelector('.autotune-max-iter');
  if (modeSel && maxIterInput) {
    const syncMaxIter = () => { maxIterInput.disabled = modeSel.value === 'bayesian'; };
    modeSel.addEventListener('change', syncMaxIter);
    syncMaxIter();
  }
  if (fileInput) {
    fileInput.addEventListener('change', async (e) => {
      const f = e.target.files && e.target.files[0];
      if (!f) return;
      try {
        const buf = await f.arrayBuffer();
        const bytes = new Uint8Array(buf);
        let bin = '';
        const CHUNK = 0x8000;
        for (let i = 0; i < bytes.length; i += CHUNK) {
          bin += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
        }
        autotuneTuneWavBase64 = btoa(bin);
        // WAV header bytes 24-27 are the sample rate (little-endian uint32).
        if (bytes.length >= 28) {
          const sr = bytes[24] | (bytes[25] << 8) | (bytes[26] << 16) | (bytes[27] << 24);
          autotuneTuneWavSampleRate = (sr >>> 0) || 0;
        }
        autotuneState.startable.tune = true;
        autotuneUpdateButtonStates();
      } catch (err) {
        autotuneOnError('failed to read WAV: ' + (err.message || err));
      }
    });
  }
  const cfgInput = tab.querySelector('.autotune-tune-config-file');
  if (cfgInput) {
    cfgInput.addEventListener('change', async (e) => {
      const f = e.target.files && e.target.files[0];
      const status = tab.querySelector('.autotune-tune-config-status');
      if (!f) {
        autotuneTuneConfig = null;
        autotuneTuneConfigName = '';
        if (status) status.textContent = '';
        if (typeof autotuneRefreshCfgStatus === 'function') autotuneRefreshCfgStatus();
        return;
      }
      try {
        const text = await f.text();
        const parsed = JSON.parse(text);
        autotuneTuneConfig = parsed;
        autotuneTuneConfigName = f.name;
        if (status) status.textContent = '✓ ' + f.name;
        if (typeof autotuneRefreshCfgStatus === 'function') autotuneRefreshCfgStatus();
      } catch (err) {
        autotuneTuneConfig = null;
        autotuneTuneConfigName = '';
        if (status) status.textContent = '✗ ' + (err.message || err);
        autotuneOnError('failed to read config JSON: ' + (err.message || err));
      }
    });
  }
  if (startBtn) startBtn.addEventListener('click', autotuneTuneStart);
  if (stopBtn) stopBtn.addEventListener('click', autotuneTuneStop);
}

async function autotuneTuneStart() {
  if (autotuneState.busy) {
    autotuneWarn(t('autotune_busy').replace('{kind}', autotuneState.busyKind));
    return;
  }
  if (!autotuneTuneWavBase64) {
    autotuneWarn(t('autotune_wav_empty'));
    return;
  }
  const tab = autotuneState.tabs.tune;
  const modules = Array.from(tab.querySelectorAll('.autotune-modules input:checked'))
    .map(c => c.value).join(',');
  if (!modules) {
    autotuneWarn(t('autotune_modules'));
    return;
  }
  const trials = parseInt(tab.querySelector('.autotune-trials').value, 10) || 50;
  const noSpeechmosCb = tab.querySelector('.autotune-tune-no-speechmos');
  const noSpeechmos = noSpeechmosCb ? noSpeechmosCb.checked : false;
  // Prefer per-run override (e.g. best_config.json from a prior tune, or a
  // known-good baseline) so the user can tune against a specific file without
  // first importing it as the dashboard's "current config".
  const cfg = autotuneTuneConfig
    || (typeof state !== 'undefined' && state.config && state.config[currentChannel]);
  if (!cfg) {
    autotuneWarn(t('no_config'));
    return;
  }
  // Read MIC/Ref from the UI inputs (pre-populated from deviceSettings, user-editable).
  // Pre-flight: AEC/AES need ≥1 ref channel or the SDK init returns NULL and every trial fails.
  const numMic = parseInt(tab.querySelector('.autotune-mic-ch').value, 10) || 2;
  const numRef = parseInt(tab.querySelector('.autotune-ref-ch').value, 10);
  const refVal = isNaN(numRef) ? 0 : numRef;
  const needsRef = modules.split(',').some(m => m === 'aec' || m === 'aes');
  if (needsRef && refVal < 1) {
    autotuneWarn(t('autotune_ref_zero_with_aec'));
    return;
  }
  const tuneSrSelect = tab.querySelector('.autotune-tune-sr');
  const sampleRate = tuneSrSelect ? (parseInt(tuneSrSelect.value, 10) || 16000) : 16000;
  if (autotuneTuneWavSampleRate && autotuneTuneWavSampleRate !== sampleRate) {
    autotuneWarn(`WAV 采样率 ${autotuneTuneWavSampleRate} Hz ≠ 调参采样率 ${sampleRate} Hz，结果可能不准确`);
  }
  // Read Phase 1/2 controls.
  const optimizeMode = (tab.querySelector('.autotune-optimize-mode') || {}).value || 'both';
  const talkType = (tab.querySelector('.autotune-talk-type') || {}).value || 'dt';
  const maxIter = parseInt(tab.querySelector('.autotune-max-iter').value, 10) || 3;
  // Reset previous-run UI; busy flag flips on so Stop becomes clickable.
  // Also reset phase tracker so the next run re-emits the Phase 1 header.
  tab.querySelector('.autotune-log').textContent = '';
  tab.querySelector('.autotune-progress').value = 0;
  tab.querySelector('.autotune-best').innerHTML = '';
  autotuneState.lastPhase = null;
  autotuneState.busy = true;
  autotuneState.busyKind = 'tune';
  autotuneUpdateButtonStates();
  try {
    const r = await autotuneSend('autotune.tune.start', Object.assign({
      wavBase64: autotuneTuneWavBase64,
      config: cfg,
      modules, trials,
      noSpeechmos,
      numMic, numRef: refVal, sampleRate,
      optimizeMode, talkType, maxIter,
    }), 10000);
    if (r && r.ok === false) {
      autotuneOnError(r.message || 'tune.start returned !ok');
      autotuneState.busy = false;
      autotuneState.busyKind = '';
      autotuneUpdateButtonStates();
    }
    // On ok, busy stays true until autotune.closed arrives (handleAutotuneMessage → autotuneOnClosed).
  } catch (err) {
    autotuneOnError(String((err && err.message) || err));
    autotuneState.busy = false;
    autotuneState.busyKind = '';
    autotuneUpdateButtonStates();
  }
}

async function autotuneTuneStop() {
  try {
    await autotuneSend('autotune.tune.stop', {}, 5000);
  } catch (err) {
    autotuneOnError(String((err && err.message) || err));
  }
}

function autotuneTuneOnProgress(msg) {
  const tab = autotuneState.tabs.tune;
  if (!tab) return;
  const phase = msg.phase || 'bayesian';  // absent → Bayesian trial (Phase 2)
  const log = tab.querySelector('.autotune-log');
  if (log) {
    // Emit a phase header when the phase changes so the user can tell where
    // they are in a two-phase run.
    if (autotuneState.lastPhase !== phase) {
      autotuneState.lastPhase = phase;
      const header = phase === 'rules' ? t('autotune_phase_rules') : t('autotune_phase_bayesian');
      log.textContent += header + '\n';
    }
    const score = typeof msg.score === 'number' ? msg.score.toFixed(3) : '?';
    const best = typeof msg.best === 'number' ? msg.best.toFixed(3) : '?';
    if (phase === 'rules') {
      // Rules iteration: score is ERLE in dB, metrics.status is PASS/WARN/FAIL.
      const status = (msg.metrics && msg.metrics.status) || '';
      log.textContent += `iter ${msg.trial}: ERLE=${score} dB (${status}) best=${best}\n`;
    } else if (msg.failed) {
      // VQE failed for this trial — make that obvious so the user doesn't
      // mistake -1.000 for "low score". The actual error is on the log lines
      // just above (stderr forwarded as autotune.log).
      log.textContent += `trial ${msg.trial}: FAILED (VQE error — see log above) best=${best}\n`;
    } else {
      log.textContent += `trial ${msg.trial}: score=${score} best=${best}\n`;
    }
    log.scrollTop = log.scrollHeight;
  }
  // Progress bar: in Phase 1 we don't know the total (rules can early-stop),
  // so only update the bar in Phase 2. Phase 1 progress is in the log text.
  if (phase === 'bayesian') {
    const trials = parseInt(tab.querySelector('.autotune-trials').value, 10) || 50;
    const progress = tab.querySelector('.autotune-progress');
    if (progress) {
      progress.max = trials;
      progress.value = Math.min(trials, (msg.trial || 0) + 1);
    }
  }
}

function autotuneTuneOnDone(msg) {
  const tab = autotuneState.tabs.tune;
  if (!tab) return;
  const best = tab.querySelector('.autotune-best');
  if (!best) return;
  // Clear any previous content before rendering the new best.
  best.innerHTML = '';

  const scoreDiv = document.createElement('div');
  const scoreLabel = document.createElement('strong');
  scoreLabel.textContent = t('autotune_best_score') + ': ';
  scoreDiv.appendChild(scoreLabel);
  scoreDiv.appendChild(document.createTextNode(
    (typeof msg.best_score === 'number' ? msg.best_score.toFixed(3) : '?') +
    ` (trial ${msg.best_trial})`
  ));
  best.appendChild(scoreDiv);

  // Best config: collapsible <details> with textContent (config is server-controlled).
  const details = document.createElement('details');
  const summary = document.createElement('summary');
  summary.textContent = t('autotune_best_config');
  details.appendChild(summary);
  const pre = document.createElement('pre');
  pre.textContent = JSON.stringify(msg.best_config || {}, null, 2);
  details.appendChild(pre);
  best.appendChild(details);

  // Output file paths from the optimizer work_dir (config_best.json, output_best.wav).
  // These are host-side paths surfaced for users who want to find the files outside the browser.
  if (msg.best_config_path || msg.best_output_path) {
    const pathDiv = document.createElement('div');
    pathDiv.style.marginTop = '6px';
    pathDiv.style.fontSize = '12px';
    pathDiv.style.color = 'var(--muted, #888)';
    const lbl = document.createElement('strong');
    lbl.textContent = t('autotune_paths_label') + ': ';
    pathDiv.appendChild(lbl);
    const segs = [];
    if (msg.best_config_path) segs.push('config: ' + msg.best_config_path);
    if (msg.best_output_path) segs.push('wav: ' + msg.best_output_path);
    pathDiv.appendChild(document.createTextNode(segs.join(' · ')));
    best.appendChild(pathDiv);
  }

  const btnRow = document.createElement('div');
  btnRow.style.marginTop = '8px';

  const applyBtn = document.createElement('button');
  applyBtn.className = 'btn sm autotune-apply';
  applyBtn.textContent = t('autotune_apply_config');
  applyBtn.addEventListener('click', () => {
    if (typeof state !== 'undefined' && state.config && msg.best_config) {
      state.config[currentChannel] = msg.best_config;
      // Re-render the param grid so the user sees the new values immediately.
      // Without this, the assignment is silent — every other config mutation
      // in params.js calls renderParams() right after touching state.config.
      if (typeof renderParams === 'function') renderParams();
      autotuneWarn(t('autotune_applied'));
      if (typeof autotuneRefreshCfgStatus === 'function') autotuneRefreshCfgStatus();
    }
  });
  btnRow.appendChild(applyBtn);

  const saveBtn = document.createElement('button');
  saveBtn.className = 'btn sm autotune-save';
  saveBtn.style.marginLeft = '6px';
  saveBtn.textContent = t('autotune_save_config');
  saveBtn.addEventListener('click', () => {
    const blob = new Blob([JSON.stringify(msg.best_config || {}, null, 2)],
                          { type: 'application/json' });
    downloadBlob('best_config.json', blob);
  });
  btnRow.appendChild(saveBtn);

  // Download the optimizer's best-trial output WAV. Disabled when the run
  // produced no audio (e.g. all trials failed before reaching the VQE output stage).
  const wavBtn = document.createElement('button');
  wavBtn.className = 'btn sm autotune-save-output';
  wavBtn.style.marginLeft = '6px';
  wavBtn.textContent = t('autotune_save_output_wav');
  if (!msg.outputBase64) {
    wavBtn.disabled = true;
    wavBtn.title = t('autotune_no_output');
  } else {
    wavBtn.addEventListener('click', () => {
      // Decode base64 to bytes; atob gives a binary string, then we charCodeAt into a Uint8Array.
      const bin = atob(msg.outputBase64);
      const bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      const blob = new Blob([bytes], { type: 'audio/wav' });
      downloadBlob('output_best.wav', blob);
    });
  }
  btnRow.appendChild(wavBtn);

  best.appendChild(btnRow);
  // autotuneOnClosed (fired next) clears busy + busyKind.
}

// ── Tab 1: Hardware tests ─────────────────────────────────────────
// Five standard signals (sweep/1k/whitenoise/whitenoise_sealed/silence) each
// row in the panel can be either auto-recorded (via tinyplay+tinycap on the
// device) or manually imported. The user's cached base64 is sent with the
// final `hw.run` so the CLI can re-read the WAVs without an extra round trip.
const autotuneHwSignals = {
  sweep: null,
  '1k': null,
  whitenoise: null,
  whitenoise_sealed: null,
  silence: null,
};

// Hardware acceptance uses the codec's TDM channel width (e.g. ES7210 = 4 ch)
// as the capture channel count — not numMic + numRef. The user must set this
// explicitly per board. Sample rate is independent of device online rate
// (H-tests threshold bands are calibrated at the rate the suite runs at).
//
// Playback and capture may live on DIFFERENT cards (e.g. HDMI playback on
// card 0, codec ADC on card 1) — they're set independently rather than
// sharing a single card index.
function autotuneHwParams() {
  const tab = autotuneState.tabs.hw;
  if (!tab) return { playbackCard: 1, captureCard: 1, captureChannels: 2, sampleRate: 48000 };
  const pbInput = tab.querySelector('[data-hw-playback-card]');
  const capInput = tab.querySelector('[data-hw-capture-card]');
  const chInput = tab.querySelector('[data-hw-capture-channels]');
  const srSelect = tab.querySelector('[data-hw-sample-rate]');
  const durInput = tab.querySelector('[data-hw-duration]');
  const parseCard = (el, dflt) => {
    const n = el ? parseInt(el.value, 10) : dflt;
    return Number.isInteger(n) && n >= 0 && n < 32 ? n : dflt;
  };
  return {
    playbackCard: parseCard(pbInput, 1),
    captureCard: parseCard(capInput, 1),
    captureChannels: chInput ? Math.max(1, parseInt(chInput.value, 10) || 2) : 2,
    sampleRate: srSelect ? (parseInt(srSelect.value, 10) || 48000) : 48000,
    durationSec: durInput ? Math.max(1, Math.min(60, parseInt(durInput.value, 10) || 10)) : 10,
  };
}

async function autotuneHwProbeCards() {
  const tab = autotuneState.tabs.hw;
  if (!tab) return;
  const out = tab.querySelector('.hw-cards-output');
  if (out) {
    out.hidden = false;
    out.textContent = t('autotune_hw_probe_running') || '...';
  }
  try {
    const r = await autotuneSend('autotune.hardware.cards', { target: {} }, 10000);
    if (out) {
      // r.cards is server-controlled — textContent only (no innerHTML).
      out.textContent = r && r.cards ? r.cards : '(no cards)';
    }
  } catch (err) {
    if (out) out.textContent = String((err && err.message) || err);
  }
}

function autotuneHwWire() {
  if (autotuneState.wiredHw) return;
  autotuneState.wiredHw = true;
  const tab = autotuneState.tabs.hw;
  if (!tab) return;
  tab.querySelectorAll('.hw-collect').forEach(btn => {
    btn.addEventListener('click', () => {
      const sig = btn.dataset.signal;
      if (sig) autotuneHwCollectSignal(sig);
    });
  });
  tab.querySelectorAll('.hw-signal-row').forEach(row => {
    const sig = row.dataset.signal;
    const input = row.querySelector('input[type=file]');
    if (!input) return;
    input.addEventListener('change', e => {
      const f = e.target.files && e.target.files[0];
      if (f) autotuneHwImportSignal(sig, f);
      // Always clear so the same file can be re-selected to re-import.
      input.value = '';
    });
  });
  const startBtn = tab.querySelector('[data-cmd="hw.run"]');
  if (startBtn) startBtn.addEventListener('click', autotuneHwRun);
  const probeBtn = tab.querySelector('[data-cmd="hw.probe-cards"]');
  if (probeBtn) probeBtn.addEventListener('click', autotuneHwProbeCards);
  tab.querySelectorAll('.hw-export').forEach(btn => {
    btn.addEventListener('click', () => {
      const sig = btn.dataset.signal;
      if (sig) autotuneHwExportSignal(sig);
    });
  });
  const exportAllBtn = tab.querySelector('[data-cmd="hw.export-all"]');
  if (exportAllBtn) exportAllBtn.addEventListener('click', autotuneHwExportAll);
}

function autotuneHwSetStatus(sig, cls, text) {
  const tab = autotuneState.tabs.hw;
  if (!tab) return;
  const row = tab.querySelector(`.hw-signal-row[data-signal="${sig}"]`);
  if (!row) return;
  const el = row.querySelector('.hw-signal-status');
  if (!el) return;
  el.className = 'hw-signal-status ' + (cls || '');
  el.textContent = text || '';
  // Export is meaningful once a WAV is cached (collected or imported).
  // Errors / pending reset disable it.
  const exportBtn = row.querySelector('.hw-export');
  if (exportBtn) exportBtn.disabled = !(cls === 'done' || cls === 'imported');
}

function autotuneHwExportSignal(sig) {
  const b64 = autotuneHwSignals[sig];
  if (!b64) {
    autotuneOnError(`no cached WAV for ${sig}`);
    return;
  }
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  const blob = new Blob([bytes], { type: 'audio/wav' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  a.href = url;
  a.download = `hw_${sig}_${ts}.wav`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function autotuneHwExportAll() {
  const sigs = ['sweep', '1k', 'whitenoise', 'whitenoise_sealed', 'silence'];
  let count = 0;
  for (const sig of sigs) {
    if (autotuneHwSignals[sig]) {
      // Stagger downloads so the browser doesn't coalesce them.
      setTimeout(() => autotuneHwExportSignal(sig), count * 300);
      count++;
    }
  }
  if (count === 0) autotuneOnError('no signals to export');
}

async function autotuneHwCollectSignal(sig) {
  if (autotuneState.busy) {
    autotuneWarn(t('autotune_busy').replace('{kind}', autotuneState.busyKind));
    return;
  }
  autotuneState.busy = true;
  autotuneState.busyKind = 'hardware';
  autotuneUpdateButtonStates();
  autotuneHwSetStatus(sig, 'recording', t('autotune_hw_status_recording'));
  try {
    const r = await autotuneSend('autotune.hardware.collect', Object.assign({
      signal: sig,
      target: {},
    }, autotuneHwParams()), 60000);
    if (r && r.wavBase64) {
      autotuneHwSignals[sig] = r.wavBase64;
      const kb = Math.max(1, Math.round((r.wavBase64.length * 3 / 4) / 1024));
      autotuneHwSetStatus(sig, 'done', t('autotune_hw_status_done') + ` (${kb} KB)`);
    }
  } catch (err) {
    autotuneHwSetStatus(sig, 'error', (t('autotune_hw_status_error') || 'Error') + ': ' + String((err && err.message) || err));
  } finally {
    autotuneState.busy = false;
    autotuneState.busyKind = '';
    autotuneUpdateButtonStates();
  }
}

async function autotuneHwImportSignal(sig, file) {
  try {
    const buf = await file.arrayBuffer();
    const bin = new TextDecoder('latin1').decode(new Uint8Array(buf));
    autotuneHwSignals[sig] = btoa(bin);
    autotuneHwSetStatus(sig, 'imported', t('autotune_hw_status_imported') + ` (${file.name})`);
  } catch (err) {
    autotuneHwSetStatus(sig, 'error', String((err && err.message) || err));
    autotuneOnError('failed to read WAV: ' + (err.message || err));
  }
}

async function autotuneHwRun() {
  if (autotuneState.busy) {
    autotuneWarn(t('autotune_busy').replace('{kind}', autotuneState.busyKind));
    return;
  }
  // Sweep/1k/whitenoise/silence are mandatory for the standard 10 tests.
  // whitenoise_sealed is optional (only needed for H6 密封性) — warn, don't block.
  const required = ['sweep', '1k', 'whitenoise', 'silence'];
  const missing = required.filter(s => !autotuneHwSignals[s]);
  if (missing.length > 0) {
    autotuneWarn(t('autotune_hw_missing') + missing.join(', '));
    return;
  }
  const tab = autotuneState.tabs.hw;
  const tbody = tab.querySelector('.autotune-hw-results tbody');
  if (tbody) tbody.innerHTML = '';
  autotuneState.busy = true;
  autotuneState.busyKind = 'hardware';
  autotuneUpdateButtonStates();
  try {
    const r = await autotuneSend('autotune.hardware.run', Object.assign({
      signalBase64: autotuneHwSignals,
      target: {},
    }, autotuneHwParams()), 300000);
    // The CLI streams one `autotune.hw.progress` event per H-test (handled by
    // autotuneHwOnProgress); the response doc here is the `done` envelope
    // (overall_status / counts) — nothing extra to render beyond the rows.
    void r;
  } catch (err) {
    autotuneOnError(String((err && err.message) || err));
  } finally {
    autotuneState.busy = false;
    autotuneState.busyKind = '';
    autotuneUpdateButtonStates();
  }
}

function autotuneHwRow(testId, testName, res) {
  const tr = document.createElement('tr');
  tr.dataset.test = testId;

  const idTd = document.createElement('td');
  idTd.textContent = testId;
  tr.appendChild(idTd);

  const nameTd = document.createElement('td');
  nameTd.textContent = testName || testId;
  tr.appendChild(nameTd);

  const statusTd = document.createElement('td');
  const status = (res && res.status) || '?';
  statusTd.className = 'status-' + String(status).toLowerCase();
  statusTd.textContent = status;
  tr.appendChild(statusTd);

  const scoreTd = document.createElement('td');
  const score = res && res.score;
  scoreTd.textContent = typeof score === 'number' ? score.toFixed(3) : '--';
  tr.appendChild(scoreTd);

  const metricsTd = document.createElement('td');
  if (res && (res.metrics || res.message)) {
    const details = document.createElement('details');
    const summary = document.createElement('summary');
    summary.textContent = '...';
    details.appendChild(summary);
    const pre = document.createElement('pre');
    // res.metrics / res.message are server-controlled — textContent only.
    pre.textContent = JSON.stringify({ metrics: res.metrics, message: res.message }, null, 2);
    details.appendChild(pre);
    metricsTd.appendChild(details);
  } else {
    metricsTd.textContent = '--';
  }
  tr.appendChild(metricsTd);
  return tr;
}

function autotuneHwOnProgress(msg) {
  // Single dispatcher for both phases:
  //   phase='collect'  — single-signal auto-record progress (status badge)
  //   phase='analyze'  — one H-test result (table row)
  //   phase='done'     — overall summary (no row; just clear busy on the JS side)
  const phase = msg.phase;
  if (phase === 'collect') {
    if (msg.status === 'recording') {
      autotuneHwSetStatus(msg.signal, 'recording', t('autotune_hw_status_recording'));
    } else if (msg.status === 'done') {
      autotuneHwSetStatus(msg.signal, 'done', t('autotune_hw_status_done'));
    }
    return;
  }
  if (phase === 'done') {
    // overall_status / counts are already in the response doc; nothing to render here.
    return;
  }
  // Default: phase === 'analyze' → table row update.
  const tab = autotuneState.tabs.hw;
  if (!tab) return;
  const tbody = tab.querySelector('.autotune-hw-results tbody');
  if (!tbody) return;
  const testId = msg.test || '?';
  const res = {
    status: msg.status,
    score: msg.score,
    metrics: msg.metrics,
    message: msg.message,
  };
  // Replace existing row for this test (final progress event wins).
  const existing = tbody.querySelector(`tr[data-test="${CSS.escape(testId)}"]`);
  if (existing) existing.remove();
  tbody.appendChild(autotuneHwRow(testId, msg.name, res));
}
