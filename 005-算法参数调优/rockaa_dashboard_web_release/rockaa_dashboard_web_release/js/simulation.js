// ── online simulation ──
const onlinePanels = {};
let onlineZIndex = 120;
let pendingRxSourcePanel = null;
const BROWSER_RECORD_SAMPLE_RATE = 16000;
const BROWSER_RECORD_DEFAULT_CHANNELS = 1;
const BROWSER_SOURCE_UPLOAD_CHUNK_BYTES = 24 * 1024;

function onlineKey(ch) {
  return String(ch || currentChannel || 'tx').toLowerCase() === 'rx' ? 'rx' : 'tx';
}

function updateGlobalOnlineState() {
  const panels = Object.values(onlinePanels);
  state.onlineRunning = panels.some(panel => panel.running);
  const active = panels.find(panel => panel.root.classList.contains('open')) || panels[0];
  if (active) {
    state.onlineChannel = active.channel;
    state.onlinePaused = active.paused;
    state.ws = active.ws;
    state.rollingInput = active.rollingInput;
    state.rollingOutput = active.rollingOutput;
  }
}

function layoutOnlinePanels() {
  const host = document.getElementById('onlineDialogHost');
  if (!host) return;
  const openPanels = Object.values(onlinePanels).filter(panel => panel.root.classList.contains('open'));
  host.classList.toggle('online-stack', openPanels.length > 0);
  openPanels.forEach((panel, index) => {
    panel.root.style.zIndex = String(130 + index);
  });
}

function handleOnlineBridgeLog(channel, message) {
  const panel = onlinePanels[onlineKey(channel)];
  if (panel && panel.root.classList.contains('open')) {
    onlineLog(panel, message);
    return;
  }
  log('[Bridge][' + (channel || '') + '] ' + message);
}

function onlineDialogHtml(key) {
  const isRx = key === 'rx';
  return `<div class="dialog" style="width:1160px;max-height:92vh">
    <div class="dialog-header">
      <h2 class="online-title">${htmlEscape(t('online_' + key))}</h2>
      <button class="btn sm online-close" type="button">${htmlEscape(t('close'))}</button>
    </div>
    <div class="online-toolbar">
      <select class="field sm online-display">
        <option value="time">${htmlEscape(t('time_domain'))}</option>
        <option value="spectrogram">${htmlEscape(t('freq_domain'))}</option>
      </select>
      <select class="field sm online-timeline">
        <option value="sync">${htmlEscape(t('synced_zoom'))}</option>
        <option value="indep">${htmlEscape(t('independent_zoom'))}</option>
      </select>
      <label style="font-size:12px;color:var(--muted)">${htmlEscape(t('online_cache'))}
        <input class="field sm online-cache" type="number" value="10" min="1" max="60" style="width:48px">s
      </label>
      <label style="font-size:12px"><input type="checkbox" class="online-unlimited"> ${htmlEscape(t('unlimited'))}</label>
      <button class="btn sm online-pause" type="button">${htmlEscape(t('online_pause'))}</button>
      <button class="btn sm danger online-stop" type="button">${htmlEscape(t('online_stop'))}</button>
      <button class="btn sm green online-start" type="button">${htmlEscape(t('online_start'))}</button>
      <span style="width:8px"></span>
      <button class="btn sm online-open-params" type="button">${htmlEscape(t('open_params'))}</button>
      <span style="flex:1"></span>
      <span class="online-status" style="font-size:12px;color:var(--muted)">${htmlEscape(t('ready'))}</span>
      ${!isRx ? `<span class="online-sed-label" style="font-size:12px;font-weight:600">${htmlEscape(t('online_sed_model'))}</span>
      <button class="btn sm online-sed-import" type="button">${htmlEscape(t('sed_model_import'))}</button>
      <button class="btn sm online-sed-auto" type="button">${htmlEscape(t('sed_model_auto'))}</button>
      <button class="btn sm online-sed-clear" type="button">${htmlEscape(t('sed_model_clear'))}</button>
      <span class="online-sed-name" style="font-size:12px;color:var(--muted)">${htmlEscape(t('sed_model_none'))}</span>
      <span class="online-sed-baby" style="display:none;font-size:12px;font-weight:600;color:#ff5f56;background:rgba(255,95,86,.12);padding:1px 8px;border-radius:10px"></span>
      <span class="online-host-playback-label" style="font-size:12px;font-weight:600">${htmlEscape(t('online_playback'))}</span>
      <select class="field sm online-host-playback" style="width:120px"><option value="off">off</option></select>` : ''}
      <button class="btn sm online-export" type="button">${htmlEscape(t('export_audio'))}</button>
    </div>
    ${isRx ? `<div class="online-rx-toolbar">
      <button class="btn sm online-rx-import" type="button">${htmlEscape(t('rx_import_source'))}</button>
      <span class="online-source-label">${htmlEscape(t('rx_source_none'))}</span>
      <span style="flex:1"></span>
      <span class="online-host-record-label" style="font-size:12px;font-weight:600">${htmlEscape(t('online_host_record'))}</span>
      <button class="btn sm online-host-record" type="button">off</button>
      <select class="field sm online-host-device" style="width:180px"><option value="">default</option></select>
      <span class="online-playback-label" style="font-size:12px;font-weight:600">${htmlEscape(t('rx_source_playback'))}</span>
      <select class="field sm online-rx-playback"><option value="off">off</option><option value="on">on</option></select>
    </div>` : ''}
    <div class="device-settings-panel compact online-device-settings" data-online-device-settings data-channel="${key}"></div>
    <div class="dialog-body" style="display:flex;flex-direction:column;gap:0;padding:4px 12px;min-height:0">
      <div class="wave-tab-row"><div class="wave-channel-tabs online-input-tabs"></div><div class="wf-info online-input-info">Input: --</div></div>
      <div class="waveform-wrap" style="min-height:80px;height:130px;resize:vertical;overflow:hidden">
        <canvas class="online-input-canvas"></canvas>
      </div>
      <div class="wave-tab-row"><div class="wave-channel-tabs online-output-tabs"></div><div class="wf-info online-output-info">Output: --</div></div>
      <div class="wave-split-handle" data-split="online"></div>
      <div class="waveform-wrap" style="min-height:80px;height:130px;resize:vertical;overflow:hidden">
        <canvas class="online-output-canvas"></canvas>
      </div>
    </div>
    <div style="padding:4px 12px 8px">
      <div class="log-split-handle"></div>
      <div class="log online-log" style="height:120px"></div>
    </div>
  </div>`;
}

function ensureOnlinePanel(ch) {
  const key = onlineKey(ch);
  if (onlinePanels[key]) return onlinePanels[key];

  const root = document.createElement('div');
  root.className = 'dialog-overlay online-window';
  root.dataset.channel = key;
  root.innerHTML = onlineDialogHtml(key);
  document.getElementById('onlineDialogHost').appendChild(root);

  const panel = {
    key,
    channel: key.toUpperCase(),
    root,
    running: false,
    paused: false,
    logPaused: false,
    _logState: null,
    logPending: [],
    ws: null,
    inputWave: new WaveformRenderer(root.querySelector('.online-input-canvas')),
    outputWave: new WaveformRenderer(root.querySelector('.online-output-canvas')),
    rollingInput: { samples: [], channels: key === 'rx' ? 2 : 2, sampleRate: 16000 },
    rollingOutput: { samples: [], channels: key === 'rx' ? 2 : 1, sampleRate: 16000 },
    rxSource: null,
    hostRecord: false,
    hostPlayback: 'off',
    browserDevicesLoaded: false,
    browserRecord: null,
    browserRecordToken: 0,
    browserRecordChannels: BROWSER_RECORD_DEFAULT_CHANNELS,
    browserProbeToken: 0,
    sourceRequestSeq: 0,
    sourceRequests: new Map(),
    sourceUploadToken: 0,
    sourceUploadInFlight: false,
    starting: false,
    stopRequested: false,
    restartRequested: false,
    restartReason: '',
    restartTimer: null,
    refs: {
      title: root.querySelector('.online-title'),
      close: root.querySelector('.online-close'),
      display: root.querySelector('.online-display'),
      timeline: root.querySelector('.online-timeline'),
      cache: root.querySelector('.online-cache'),
      unlimited: root.querySelector('.online-unlimited'),
      pause: root.querySelector('.online-pause'),
      stop: root.querySelector('.online-stop'),
      start: root.querySelector('.online-start'),
      status: root.querySelector('.online-status'),
      hostPlaybackLabel: root.querySelector('.online-host-playback-label'),
      hostPlayback: root.querySelector('.online-host-playback'),
      sedLabel: root.querySelector('.online-sed-label'),
      sedImport: root.querySelector('.online-sed-import'),
      sedAuto: root.querySelector('.online-sed-auto'),
      sedClear: root.querySelector('.online-sed-clear'),
      sedName: root.querySelector('.online-sed-name'),
      sedBaby: root.querySelector('.online-sed-baby'),
      export: root.querySelector('.online-export'),
      openParams: root.querySelector('.online-open-params'),
      inputTabs: root.querySelector('.online-input-tabs'),
      outputTabs: root.querySelector('.online-output-tabs'),
      inputInfo: root.querySelector('.online-input-info'),
      outputInfo: root.querySelector('.online-output-info'),
      log: root.querySelector('.online-log'),
      deviceSettings: root.querySelector('.online-device-settings'),
      rxImport: root.querySelector('.online-rx-import'),
      rxSourceLabel: root.querySelector('.online-source-label'),
      hostRecordLabel: root.querySelector('.online-host-record-label'),
      hostRecord: root.querySelector('.online-host-record'),
      hostDevice: root.querySelector('.online-host-device'),
      playbackLabel: root.querySelector('.online-playback-label'),
      rxPlayback: root.querySelector('.online-rx-playback'),
    },
  };
  panel.outputWave.color = '#52a6ff';
  panel.outputWave.outputPreview = true;
  panel.inputWave.color = '#36c57e';
  panel.inputWave.channels = panel.rollingInput.channels;
  panel.inputWave.sampleRate = panel.rollingInput.sampleRate;
  // Perf panel sits right below the toolbar so it is visible from the
  // moment the window opens, showing placeholders until data arrives.
  ensureOnlinePerfBar(panel);
  panel.outputWave.channels = panel.rollingOutput.channels;
  panel.outputWave.sampleRate = panel.rollingOutput.sampleRate;
  panel.inputWave.onViewChange = source => syncOnlineWaveforms(panel, source);
  panel.outputWave.onViewChange = source => syncOnlineWaveforms(panel, source);

  panel.refs.display.addEventListener('change', () => configureOnlineWaveforms(panel));
  panel.refs.timeline.addEventListener('change', () => configureOnlineWaveforms(panel));
  panel.refs.pause.addEventListener('click', () => toggleOnlinePause(key));
  panel.refs.stop.addEventListener('click', () => stopOnline(key));
  panel.refs.start.addEventListener('click', () => startOnlineStream(key));
  panel.refs.export.addEventListener('click', () => exportOnlineAudio(key));
  panel.refs.close.addEventListener('click', () => closeOnlineDialog());
  bindWaveSplitters();
  panel.refs.openParams.addEventListener('click', () => {
    if (typeof openParamWindow === 'function') openParamWindow(panel.key);
  });
  root.querySelector('.dialog').addEventListener('pointerdown', () => bringOnlinePanelToFront(panel));
  if (panel.refs.rxImport)
    panel.refs.rxImport.addEventListener('click', () => chooseRxSource(panel));
  if (panel.refs.hostRecord)
    panel.refs.hostRecord.addEventListener('click', () => toggleRxHostRecord(panel));
  if (panel.refs.hostDevice)
    panel.refs.hostDevice.addEventListener('change', async () => {
      if (panel.hostRecord) {
        const option = panel.refs.hostDevice.selectedOptions[0];
        try {
          await prepareBrowserRecordChannels(panel);
          restartRxOnlineSource(panel,
            'RX 当前浏览器录音设备: ' + (option ? option.text : 'default'));
        } catch (err) {
          onlineLog(panel, '读取当前浏览器录音通道失败: ' + err.message);
        }
      }
    });
  if (panel.refs.rxPlayback)
    panel.refs.rxPlayback.addEventListener('change', () => restartRxOnlineSource(panel, 'RX 音源播放: ' + panel.refs.rxPlayback.value));
  if (panel.refs.hostPlayback)
    panel.refs.hostPlayback.addEventListener('change', () => updateOnlineHostPlayback(panel));
  if (panel.refs.sedImport)
    panel.refs.sedImport.addEventListener('click', () => chooseSedModel(panel));
  if (panel.refs.sedAuto)
    panel.refs.sedAuto.addEventListener('click', () => useAutoSedModelForTx(panel));
  if (panel.refs.sedClear)
    panel.refs.sedClear.addEventListener('click', () => clearSedModelForTx(panel));

  onlinePanels[key] = panel;
  bindLogFeatures(panel);
  bindLogSplitters();
  renderOnlineDeviceSettings(panel);
  rebuildOnlineHostPlaybackChoices(panel);
  updateSedModelLabel(panel);
  configureOnlineWaveforms(panel);
  return panel;
}

function renderChannelTabs(container, renderer, channels, prefix) {
  if (!container || !renderer) return;
  const count = Math.max(1, Number(channels) || 1);
  renderer.channelIndex = Math.floor(clamp(renderer.channelIndex || 0, 0, count - 1));

  if (!container._waveTabsBound) {
    const selectChannel = ev => {
      const tab = ev.target.closest('.wave-channel-tab');
      if (!tab || !container.contains(tab)) return;
      ev.preventDefault();
      ev.stopPropagation();
      const targetRenderer = container._waveRenderer;
      if (!targetRenderer) return;
      targetRenderer.channelIndex = Number(tab.dataset.channel) || 0;
      updateChannelTabState(container);
      targetRenderer.paint();
    };
    container.addEventListener('pointerdown', selectChannel);
    container.addEventListener('click', selectChannel);
    container._waveTabsBound = true;
  }

  if (container._waveChannelCount !== count || container._wavePrefix !== prefix) {
    let html = '';
    for (let i = 0; i < count; i++) {
      html += `<button class="wave-channel-tab" type="button" data-channel="${i}">${prefix}${i}</button>`;
    }
    container.innerHTML = html;
    container._waveChannelCount = count;
    container._wavePrefix = prefix;
  }

  container._waveRenderer = renderer;
  updateChannelTabState(container);
}

function updateChannelTabState(container) {
  const renderer = container && container._waveRenderer;
  if (!renderer) return;
  const current = Math.floor(renderer.channelIndex || 0);
  container.querySelectorAll('.wave-channel-tab').forEach(btn => {
    btn.classList.toggle('active', Number(btn.dataset.channel) === current);
  });
}

function bringOnlinePanelToFront(panel) {
  if (document.getElementById('onlineDialogHost').classList.contains('online-stack')) return;
  panel.root.style.zIndex = String(++onlineZIndex);
  state.onlineChannel = panel.channel;
  updateGlobalOnlineState();
}

function renderOnlineDeviceSettings(panel) {
  panel.refs.deviceSettings.innerHTML = deviceSettingsMarkup(panel.key, true);
}

function onlineHostPlaybackPayload(panel) {
  if (!panel || panel.key !== 'tx')
    return { stream: '', channel: 0 };
  const value = panel && panel.refs.hostPlayback ? panel.refs.hostPlayback.value : 'off';
  const parts = String(value || 'off').split(':');
  if (parts.length !== 2 || parts[0] !== 'output')
    return { stream: '', channel: 0 };
  const channel = Number(parts[1]);
  if (!Number.isInteger(channel) || channel < 0)
    return { stream: '', channel: 0 };
  return { stream: parts[0], channel };
}

function stopBrowserPlayback(panel) {
  if (!panel || !panel.browserPlayback) return;
  if (panel.browserPlayback.sources) {
    panel.browserPlayback.sources.forEach(source => {
      try { source.stop(); } catch (_) {}
    });
    panel.browserPlayback.sources.clear();
  }
  panel.browserPlayback.nextTime = 0;
  panel.browserPlayback.warned = false;
}

function ensureBrowserPlayback(panel) {
  if (!panel) return null;
  const AudioContextCtor = window.AudioContext || window.webkitAudioContext;
  if (!AudioContextCtor) {
    if (!panel.browserPlayback || !panel.browserPlayback.warned) {
      panel.browserPlayback = panel.browserPlayback || {};
      panel.browserPlayback.warned = true;
      onlineLog(panel, '当前浏览器不支持 WebAudio，无法远程播放音频');
    }
    return null;
  }
  panel.browserPlayback = panel.browserPlayback || {};
  if (!panel.browserPlayback.ctx)
    panel.browserPlayback.ctx = new AudioContextCtor();
  if (!panel.browserPlayback.sources)
    panel.browserPlayback.sources = new Set();
  if (panel.browserPlayback.ctx.state === 'suspended')
    panel.browserPlayback.ctx.resume().catch(() => {});
  return panel.browserPlayback;
}

function stopBrowserRecord(panel) {
  if (!panel) return;
  panel.browserRecordToken = (panel.browserRecordToken || 0) + 1;
  const record = panel.browserRecord;
  panel.browserRecord = null;
  if (!record) return;
  record.stopping = true;
  if (record.processor) {
    record.processor.onaudioprocess = null;
    try { record.processor.disconnect(); } catch (_) {}
  }
  if (record.source) {
    try { record.source.disconnect(); } catch (_) {}
  }
  if (record.stream)
    record.stream.getTracks().forEach(track => track.stop());
  if (record.ctx && record.ctx.state !== 'closed')
    record.ctx.close().catch(() => {});
}

function browserCaptureChannelCount(stream, fallback) {
  const track = stream && stream.getAudioTracks && stream.getAudioTracks()[0];
  const settings = track && typeof track.getSettings === 'function' ? track.getSettings() : {};
  const channels = Number(settings && settings.channelCount);
  if (Number.isFinite(channels)) return Math.max(1, Math.min(32, Math.floor(channels)));
  return Math.max(1, Math.min(32, Math.floor(Number(fallback) || BROWSER_RECORD_DEFAULT_CHANNELS)));
}

function browserRecordAudioConstraints(panel, channels) {
  const audio = {
    sampleRate: { ideal: BROWSER_RECORD_SAMPLE_RATE },
    echoCancellation: false,
    noiseSuppression: false,
    autoGainControl: false,
  };
  if (channels) audio.channelCount = { ideal: channels };
  const deviceId = panel && panel.refs.hostDevice ? panel.refs.hostDevice.value : '';
  if (deviceId) audio.deviceId = { exact: deviceId };
  return audio;
}

function syncRxSourceChannels(panel, channels) {
  let count = Math.max(1, Math.min(32, Math.floor(Number(channels) || 1)));
  if (typeof syncRxDeviceSettingsFromSource === 'function')
    count = syncRxDeviceSettingsFromSource(count);
  if (panel) {
    panel.browserRecordChannels = count;
    resetOnlinePanelBuffers(panel);
    refreshOnlineWaveforms(panel);
  }
  return count;
}

async function prepareBrowserRecordChannels(panel) {
  if (!navigator.mediaDevices || typeof navigator.mediaDevices.getUserMedia !== 'function')
    throw new Error('当前浏览器不支持麦克风录音');
  const token = (panel.browserProbeToken || 0) + 1;
  panel.browserProbeToken = token;
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: browserRecordAudioConstraints(panel),
  });
  try {
    if (token !== panel.browserProbeToken || !panel.hostRecord) return null;
    const channels = syncRxSourceChannels(panel,
      browserCaptureChannelCount(stream, BROWSER_RECORD_DEFAULT_CHANNELS));
    onlineLog(panel, `当前浏览器录音通道: ${channels}ch`);
    return channels;
  } finally {
    stream.getTracks().forEach(track => track.stop());
  }
}

function browserRecordPcm16(record, inputBuffer) {
  const sourceRate = Number(inputBuffer.sampleRate) || BROWSER_RECORD_SAMPLE_RATE;
  const ratio = sourceRate / BROWSER_RECORD_SAMPLE_RATE;
  const frames = inputBuffer.length || 0;
  if (!frames || !Number.isFinite(ratio) || ratio <= 0) return new ArrayBuffer(0);

  const sourceChannels = Math.max(1, inputBuffer.numberOfChannels || 1);
  const source = [];
  for (let channel = 0; channel < sourceChannels; channel++)
    source.push(inputBuffer.getChannelData(channel));

  const startFrame = record.inputFrames || 0;
  const endFrame = startFrame + frames;
  let position = Math.max(startFrame, Number(record.nextInputFrame) || startFrame);
  const maxFrames = Math.ceil((endFrame - position) / ratio) + 1;
  const buffer = new ArrayBuffer(maxFrames * record.channels * 2);
  const view = new DataView(buffer);
  let outputFrames = 0;
  while (position < endFrame) {
    const local = position - startFrame;
    const first = Math.min(frames - 1, Math.floor(local));
    const second = Math.min(frames - 1, first + 1);
    const fraction = local - first;
    let mono = 0;
    for (let channel = 0; channel < sourceChannels; channel++) {
      const samples = source[channel];
      mono += samples[first] + (samples[second] - samples[first]) * fraction;
    }
    const clipped = Math.max(-1, Math.min(1, mono / sourceChannels || 0));
    for (let channel = 0; channel < record.channels; channel++) {
      view.setInt16((outputFrames * record.channels + channel) * 2,
        clipped < 0 ? clipped * 32768 : clipped * 32767, true);
    }
    outputFrames++;
    position += ratio;
  }
  record.inputFrames = endFrame;
  record.nextInputFrame = position;
  return buffer.slice(0, outputFrames * record.channels * 2);
}

function sendBrowserRecordChunk(panel, buffer) {
  const socket = panel && panel.ws;
  if (!socket || socket.readyState !== WebSocket.OPEN || !buffer.byteLength) return;
  if (socket.bufferedAmount > 512 * 1024) {
    if (!panel.browserRecordBackpressureLogged) {
      panel.browserRecordBackpressureLogged = true;
      onlineLog(panel, '浏览器录音网络拥塞，已丢弃部分 PCM');
    }
    return;
  }
  panel.browserRecordBackpressureLogged = false;
  socket.send(JSON.stringify({
    cmd: 'online.source.write',
    channel: panel.channel,
    base64: arrayBufferToBase64(buffer),
  }));
}

function rejectOnlineSourceRequests(panel, message) {
  if (!panel) return;
  panel.sourceUploadToken = (panel.sourceUploadToken || 0) + 1;
  panel.sourceUploadInFlight = false;
  const error = message instanceof Error ? message : new Error(message || 'RX 音源传输已中断');
  if (!panel.sourceRequests) return;
  for (const pending of panel.sourceRequests.values()) {
    clearTimeout(pending.timer);
    pending.reject(error);
  }
  panel.sourceRequests.clear();
}

function sendOnlineSourceRequest(panel, cmd, payload, timeoutMs) {
  const socket = panel && panel.ws;
  if (!socket || socket.readyState !== WebSocket.OPEN)
    return Promise.reject(new Error('RX 音源在线流未连接'));
  const id = ++panel.sourceRequestSeq;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      panel.sourceRequests.delete(id);
      reject(new Error(cmd + ' timeout'));
    }, timeoutMs || 30000);
    panel.sourceRequests.set(id, { resolve, reject, timer });
    try {
      socket.send(JSON.stringify(Object.assign({ id, cmd, channel: panel.channel }, payload || {})));
    } catch (err) {
      clearTimeout(timer);
      panel.sourceRequests.delete(id);
      reject(err);
    }
  });
}

function greatestCommonDivisor(a, b) {
  let left = Math.max(1, Math.floor(a));
  let right = Math.max(1, Math.floor(b));
  while (right) {
    const next = left % right;
    left = right;
    right = next;
  }
  return left;
}

function browserFileUploadChunkBase64Length(channels) {
  const frameBytes = Math.max(1, Math.min(32, Math.floor(Number(channels) || 1))) * 2;
  const groupBytes = frameBytes * 3 / greatestCommonDivisor(frameBytes, 3);
  const bytes = Math.max(groupBytes,
    Math.floor(BROWSER_SOURCE_UPLOAD_CHUNK_BYTES / groupBytes) * groupBytes);
  return bytes / 3 * 4;
}

async function uploadRxSourceFile(panel) {
  const source = panel && panel.rxSource;
  if (!source || panel.hostRecord || !source.base64) return;
  const token = (panel.sourceUploadToken || 0) + 1;
  panel.sourceUploadToken = token;
  const totalBytes = Number(source.bytes) || 0;
  if (!totalBytes) throw new Error('RX 音源为空');
  onlineLog(panel, `开始通过在线流发送 RX 音源: ${source.fileName}`);
  let offset = 0;
  let bytesSent = 0;
  const chunkLength = browserFileUploadChunkBase64Length(source.channels);
  while (offset < source.base64.length) {
    if (token !== panel.sourceUploadToken)
      throw new Error('RX 音源传输已取消');
    const nextOffset = Math.min(source.base64.length, offset + chunkLength);
    const base64 = source.base64.slice(offset, nextOffset);
    const result = await sendOnlineSourceRequest(panel, 'online.source.file.write', { base64 });
    if (token !== panel.sourceUploadToken)
      throw new Error('RX 音源传输已取消');
    bytesSent = Number(result && result.bytesReceived) || bytesSent;
    offset = nextOffset;
  }
  const result = await sendOnlineSourceRequest(panel, 'online.source.file.end');
  if (token !== panel.sourceUploadToken)
    throw new Error('RX 音源传输已取消');
  const received = Number(result && result.bytesReceived) || bytesSent;
  if (received !== totalBytes)
    throw new Error(`RX 音源字节数不匹配: ${received}/${totalBytes}`);
  onlineLog(panel, `RX 音源已发送到 Host Bridge: ${received} bytes`);
}

function startRxSourceUpload(panel) {
  if (!panel || panel.sourceUploadInFlight) return;
  const token = (panel.sourceUploadToken || 0) + 1;
  panel.sourceUploadInFlight = true;
  uploadRxSourceFile(panel).catch(err => {
    if (token !== panel.sourceUploadToken) return;
    onlineLog(panel, 'RX 音源发送失败: ' + err.message);
    stopOnlineStream(panel.key);
  }).finally(() => {
    if (token === panel.sourceUploadToken)
      panel.sourceUploadInFlight = false;
  });
}

async function startBrowserRecord(panel) {
  if (!panel || panel.key !== 'rx' || !panel.hostRecord || !panel.running || !panel.ws)
    return;
  if (panel.browserRecord) return;
  if (!navigator.mediaDevices || typeof navigator.mediaDevices.getUserMedia !== 'function') {
    failOnlineStream(panel, '当前浏览器不支持麦克风录音');
    return;
  }
  const AudioContextCtor = window.AudioContext || window.webkitAudioContext;
  if (!AudioContextCtor) {
    failOnlineStream(panel, '当前浏览器不支持 WebAudio 录音');
    return;
  }

  const token = (panel.browserRecordToken || 0) + 1;
  panel.browserRecordToken = token;
  const channels = Math.max(1, Math.min(32, Math.floor(Number(panel.browserRecordChannels)
    || Number(onlineChannelConfigFor('rx').inputChannels) || BROWSER_RECORD_DEFAULT_CHANNELS)));

  let stream = null;
  let ctx = null;
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      audio: browserRecordAudioConstraints(panel, channels),
    });
    if (token !== panel.browserRecordToken || !panel.hostRecord || !panel.running) {
      stream.getTracks().forEach(track => track.stop());
      return;
    }
    const activeChannels = browserCaptureChannelCount(stream, channels);
    if (activeChannels !== channels) {
      stream.getTracks().forEach(track => track.stop());
      syncRxSourceChannels(panel, activeChannels);
      restartRxOnlineSource(panel, `当前浏览器录音通道已更新为 ${activeChannels}ch`);
      return;
    }
    try {
      ctx = new AudioContextCtor({ sampleRate: BROWSER_RECORD_SAMPLE_RATE });
    } catch (_) {
      ctx = new AudioContextCtor();
    }
    if (ctx.state === 'suspended') await ctx.resume();
    if (token !== panel.browserRecordToken || !panel.hostRecord || !panel.running) {
      stream.getTracks().forEach(track => track.stop());
      ctx.close().catch(() => {});
      return;
    }

    const source = ctx.createMediaStreamSource(stream);
    const record = {
      token,
      stream,
      ctx,
      source,
      processor: null,
      channels,
      inputFrames: 0,
      nextInputFrame: 0,
      stopping: false,
    };
    const processor = ctx.createScriptProcessor(1024, channels, 1);
    record.processor = processor;
    processor.onaudioprocess = event => {
      for (let channel = 0; channel < event.outputBuffer.numberOfChannels; channel++)
        event.outputBuffer.getChannelData(channel).fill(0);
      if (panel.browserRecord !== record || record.stopping) return;
      sendBrowserRecordChunk(panel, browserRecordPcm16(record, event.inputBuffer));
    };
    stream.getAudioTracks().forEach(track => track.addEventListener('ended', () => {
      if (panel.browserRecord === record && !record.stopping) {
        onlineLog(panel, '当前浏览器录音设备已断开');
        stopOnlineStream(panel.key);
      }
    }));
    panel.browserRecord = record;
    source.connect(processor);
    processor.connect(ctx.destination);
    await loadBrowserCaptureDevices(panel, true);
    onlineLog(panel,
      `当前浏览器录音已启动: ${ctx.sampleRate}Hz → ${BROWSER_RECORD_SAMPLE_RATE}Hz, ${channels}ch`);
  } catch (err) {
    if (!panel.browserRecord || panel.browserRecord.token !== token) {
      if (stream) stream.getTracks().forEach(track => track.stop());
      if (ctx && ctx.state !== 'closed') ctx.close().catch(() => {});
    }
    if (token === panel.browserRecordToken)
      failOnlineStream(panel, '当前浏览器录音失败: ' + err.message);
  }
}

function feedBrowserPlayback(panel, kind, samples, channels, sampleRate) {
  if (!panel || panel.key !== 'tx' || kind !== 'output') return;
  const playback = onlineHostPlaybackPayload(panel);
  if (!playback.stream || playback.stream !== kind) return;
  const srcChannels = Math.max(1, channels || 1);
  if (playback.channel < 0 || playback.channel >= srcChannels) return;
  const state = ensureBrowserPlayback(panel);
  const ctx = state && state.ctx;
  if (!ctx || ctx.state === 'closed') return;

  const frames = Math.floor(samples.length / srcChannels);
  if (!frames) return;
  const rate = Math.max(1, sampleRate || 16000);
  const audio = ctx.createBuffer(1, frames, rate);
  const mono = audio.getChannelData(0);
  for (let frame = 0; frame < frames; frame++)
    mono[frame] = samples[frame * srcChannels + playback.channel] || 0;

  if (!state.nextTime || state.nextTime < ctx.currentTime)
    state.nextTime = ctx.currentTime + 0.03;
  if (state.nextTime - ctx.currentTime > 0.8)
    state.nextTime = ctx.currentTime + 0.03;

  const source = ctx.createBufferSource();
  source.buffer = audio;
  source.connect(ctx.destination);
  state.sources.add(source);
  source.onended = () => state.sources.delete(source);
  source.start(state.nextTime);
  state.nextTime += frames / rate;
}

function rebuildOnlineHostPlaybackChoices(panel) {
  const select = panel && panel.refs.hostPlayback;
  if (!select) return;
  const current = select.value || panel.hostPlayback || 'off';
  const cfg = onlineChannelConfigFor(panel.key);
  const outputChannels = Math.max(1, panel.rollingOutput.channels || cfg.outputChannels || 1);
  if (select._outputChannels === outputChannels
      && select.options.length > 0) {
    panel.hostPlayback = select.value || 'off';
    return;
  }
  const options = ['<option value="off">off</option>'];
  for (let index = 0; index < outputChannels; index++)
    options.push(`<option value="output:${index}">out-ch${index}</option>`);
  select.innerHTML = options.join('');
  select._outputChannels = outputChannels;
  select.value = [...select.options].some(option => option.value === current) ? current : 'off';
  panel.hostPlayback = select.value;
}

function updateOnlineHostPlayback(panel) {
  if (!panel || !panel.refs.hostPlayback) return;
  rebuildOnlineHostPlaybackChoices(panel);
  panel.hostPlayback = panel.refs.hostPlayback.value || 'off';
  if (panel.hostPlayback === 'off') stopBrowserPlayback(panel);
  else ensureBrowserPlayback(panel);
  if (!panel.running || !bridgeIsOpen()) return;
  sendBridgeCommand('online.playback', {
    channel: panel.channel,
    playback: { stream: '', channel: 0 },
    target: currentBridgeTarget(),
  }, 5000).catch(err => onlineLog(panel, '主机播放切换失败: ' + err.message));
}

function rxSourceLabelText(panel) {
  if (panel.hostRecord)
    return `${t('rx_source_host')} | ${panel.browserRecordChannels || BROWSER_RECORD_DEFAULT_CHANNELS}ch`;
  if (panel.rxSource)
    return `${t('rx_source_prefix')}: ${panel.rxSource.fileName} | ${panel.rxSource.channels}ch | `
      + `${panel.rxSource.sampleRate}Hz | ${panel.rxSource.seconds.toFixed(2)}s`;
  return t('rx_source_none');
}

function updateRxSourceLabel(panel) {
  if (panel && panel.refs.rxSourceLabel)
    panel.refs.rxSourceLabel.textContent = rxSourceLabelText(panel);
}

function rxOnlineSourceReady(panel) {
  return panel && panel.key === 'rx' && (panel.hostRecord || !!panel.rxSource);
}

function maybeAutoStartOnline(panel) {
  if (!panel || panel.running || panel.starting) return;
  if (panel.key === 'rx' && !rxOnlineSourceReady(panel)) {
    onlineLog(panel, 'RX 在线仿真等待导入 RX 音源或开启主机录音');
    panel.refs.status.textContent = t('ready');
    return;
  }
  setTimeout(() => startOnlineStream(panel.key), 0);
}

function refreshOnlinePanelLanguage(panel) {
  if (!panel) return;
  panel.refs.title.textContent = t('online_' + panel.key);
  panel.refs.close.textContent = t('close');
  panel.refs.pause.textContent = panel.paused ? t('online_resume') : t('online_pause');
  panel.refs.stop.textContent = t('online_stop');
  panel.refs.start.textContent = t('online_start');
  panel.refs.openParams.textContent = t('open_params');
  panel.refs.export.textContent = t('export_audio');
  panel.refs.display.options[0].textContent = t('time_domain');
  panel.refs.display.options[1].textContent = t('freq_domain');
  panel.refs.timeline.options[0].textContent = t('synced_zoom');
  panel.refs.timeline.options[1].textContent = t('independent_zoom');
  if (panel.refs.rxImport) panel.refs.rxImport.textContent = t('rx_import_source');
  if (panel.refs.hostRecordLabel) panel.refs.hostRecordLabel.textContent = t('online_host_record');
  if (panel.refs.hostPlaybackLabel) panel.refs.hostPlaybackLabel.textContent = t('online_playback');
  if (panel.refs.sedLabel) panel.refs.sedLabel.textContent = t('online_sed_model');
  if (panel.refs.sedImport) panel.refs.sedImport.textContent = t('sed_model_import');
  if (panel.refs.sedAuto) panel.refs.sedAuto.textContent = t('sed_model_auto');
  if (panel.refs.sedClear) panel.refs.sedClear.textContent = t('sed_model_clear');
  updateSedModelLabel(panel);
  if (panel.refs.playbackLabel) panel.refs.playbackLabel.textContent = t('rx_source_playback');
  updateRxSourceLabel(panel);
}

function refreshOnlinePanelsLanguage() {
  Object.values(onlinePanels).forEach(panel => {
    refreshOnlinePanelLanguage(panel);
    renderOnlineDeviceSettings(panel);
  });
}

function syncOnlineWaveforms(panel, source) {
  if (panel.refs.timeline.value !== 'sync') return;
  const target = source === panel.inputWave ? panel.outputWave : panel.inputWave;
  if (!target) return;
  target.copyViewFrom(source);
}

function configureOnlineWaveforms(panel) {
  if (!panel) return;
  const displayMode = panel.refs.display.value;
  panel.inputWave.displayMode = displayMode;
  panel.outputWave.displayMode = displayMode;
  renderChannelTabs(panel.refs.inputTabs, panel.inputWave, panel.inputWave.channels, 'ch');
  renderChannelTabs(panel.refs.outputTabs, panel.outputWave, panel.outputWave.channels, 'ch');
  if (panel.refs.timeline.value === 'sync')
    panel.outputWave.copyViewFrom(panel.inputWave);
  panel.inputWave.paint();
  panel.outputWave.paint();
}

function onlineLog(panel, message) {
  const ts = new Date().toLocaleTimeString();
  const text = String(message || '').replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  const el = panel.refs.log;
  if (el._highlighted) {
    el.textContent = el.textContent;
    el._highlighted = false;
  }
  if (panel._logState && panel._logState.paused) {
    const lines = text.split('\n');
    lines.forEach(l => {
      const trimmed = l.trimEnd();
      if (trimmed.length > 0) panel._logState.pending.push(`[${ts}] ${trimmed}`);
    });
    return;
  }
  const lines = text.split('\n');
  lines.forEach(l => {
    const trimmed = l.trimEnd();
    if (trimmed.length > 0) appendLogLine(el, `[${ts}] ${trimmed}`);
  });
}

function appendLogLine(el, line) {
  el.appendChild(document.createTextNode(line + '\n'));
  el.scrollTop = el.scrollHeight;
  while (el.childNodes.length > 5000)
    el.removeChild(el.firstChild);
}

// ── online/offline performance panel ──
// rockaa_perf.c (board side) prints periodic ROCKAA_PERF records; the
// bridge forwards them as {type:'online.perf'} and this bar renders
// current/avg/peak CPU + memory, NPU load and RTF, refreshed per
// interval. The interval stepper pushes the value to a running
// simulation through the bridge (board sampler re-reads an interval
// file) and also seeds the env used by the next start. The perf-stats
// switch mutes the board sampler via the same file ("off"), clears the
// shown values and keeps them at '--' until switched back on.

function perfInterval() {
  return state.perfInterval || 3;
}

function perfStatsEnabled() {
  return state.perfEnabled !== false;
}

function formatPerfMem(kb) {
  if (kb === null || kb === undefined || isNaN(kb)) return '--';
  return kb >= 1024 ? (kb / 1024).toFixed(1) + ' MB' : Math.round(kb) + ' kB';
}

function ensureOnlinePerfBar(panel) {
  if (panel.perfBar) return panel.perfBar;
  const bar = document.createElement('div');
  bar.className = 'online-perf-bar';
  bar.style.cssText = 'display:flex;gap:18px;align-items:center;flex-wrap:wrap;'
    + 'margin:0 12px;padding:6px 12px;font-size:12px;color:#9fb2c4;'
    + 'background:#141a21;border:1px solid #232c36;border-radius:6px;';
  bar.innerHTML =
      '<span data-role="cpu" title="CPU 占用：当前 / 平均 / 峰值">CPU --</span>'
    + '<span data-role="mem" title="内存占用：当前 / 平均 / 峰值">MEM --</span>'
    + '<span data-role="npu" title="NPU 占用率（/proc/rknpu/load，未使用显示 0）">NPU --</span>'
    + '<span data-role="rtf" title="RTF = 算法计算耗时 / 已处理音频时长">RTF --</span>'
    + '<span data-role="time" title="运行时长 / 已处理音频时长">--</span>'
    + '<span data-role="hint" style="color:#5c6b7a">' + onlinePerfHintIdle() + '</span>'
    + '<span style="margin-left:auto;display:inline-flex;align-items:center;gap:8px">'
    + '<label style="display:inline-flex;align-items:center;gap:4px;cursor:pointer" '
    + 'title="' + t('perf_stats') + '">'
    + '<input type="checkbox" data-role="perfToggle" checked style="margin:0;">'
    + '<span data-i18n="perf_stats">' + t('perf_stats') + '</span>'
    + '</label>'
    + '<span style="width:1px;height:14px;background:#232c36;"></span>'
    + '<span style="display:inline-flex;align-items:center;gap:4px" '
    + 'title="性能采样间隔（1~10s，实时生效）">'
    + '<button data-role="dec" style="width:22px;height:22px;line-height:1;">−</button>'
    + '<span data-role="interval" style="min-width:24px;text-align:center">3s</span>'
    + '<button data-role="inc" style="width:22px;height:22px;line-height:1;">+</button>'
    + '</span>'
    + '</span>';
  bar.querySelector('[data-role=dec]').onclick = () => adjustPerfInterval(panel, -1);
  bar.querySelector('[data-role=inc]').onclick = () => adjustPerfInterval(panel, +1);
  const toggle = bar.querySelector('[data-role=perfToggle]');
  toggle.checked = perfStatsEnabled();
  toggle.onchange = () => setPerfStatsEnabled(panel, toggle.checked);
  const toolbar = panel.root.querySelector('.online-toolbar');
  toolbar.parentNode.insertBefore(bar, toolbar.nextSibling);
  panel.perfBar = bar;
  refreshPerfIntervalLabel(panel);
  if (!perfStatsEnabled())
    clearOnlinePerfBar(panel);
  return bar;
}

function refreshPerfIntervalLabel(panel) {
  if (!panel.perfBar) return;
  panel.perfBar.querySelector('[data-role=interval]').textContent = perfInterval() + 's';
}

function setOnlinePerfHint(panel, text) {
  const bar = panel.perfBar || ensureOnlinePerfBar(panel);
  const hint = bar.querySelector('[data-role=hint]');
  if (hint) {
    hint.style.display = '';
    hint.textContent = text;
  }
}

function onlinePerfHintIdle() {
  return '等待性能数据…（点击“启动”运行在线仿真后，按采样间隔刷新）';
}

// Reset every shown value to '--' and show the disabled hint.
function clearOnlinePerfBar(panel) {
  const bar = panel.perfBar || ensureOnlinePerfBar(panel);
  bar.querySelector('[data-role=cpu]').textContent = 'CPU --';
  bar.querySelector('[data-role=mem]').textContent = 'MEM --';
  bar.querySelector('[data-role=npu]').textContent = 'NPU --';
  bar.querySelector('[data-role=rtf]').textContent = 'RTF --';
  bar.querySelector('[data-role=time]').textContent = '--';
  setOnlinePerfHint(panel, t('perf_stats_hint_off'));
}

// Mute or unmute the board-side sampler; "off" also tells rockaa to
// drop its accumulated statistics, so resuming starts from zero.
function setPerfStatsEnabled(panel, enabled) {
  state.perfEnabled = enabled;
  sendBridgeCommand('online.perf.toggle', {
      enabled, interval: perfInterval(), target: currentBridgeTarget() }, 5000)
    .then(res => {
      if (res && res.failed && res.failed.length)
        onlineLog(panel, t('perf_stats') + (enabled ? ' 开启（设备写入失败: '
          + res.failed.join('/') + '）' : ' 关闭（设备写入失败: ' + res.failed.join('/') + '）'));
      else
        onlineLog(panel, t('perf_stats') + (enabled ? ' 开启' : ' 关闭'));
    })
    .catch(err => onlineLog(panel, t('perf_stats') + ' 切换失败: ' + err.message));
  if (enabled)
    setOnlinePerfHint(panel, '采样中（每 ' + perfInterval() + 's 刷新）…');
  else
    clearOnlinePerfBar(panel);
}

function adjustPerfInterval(panel, delta) {
  const next = Math.min(10, Math.max(1, perfInterval() + delta));
  if (next === perfInterval()) return;
  state.perfInterval = next;
  refreshPerfIntervalLabel(panel);
  onlineLog(panel, '性能采样间隔调整为 ' + next + 's');
  // While stats are off, an integer would resume the sampler, so only
  // remember the value; it is pushed with the next enable toggle.
  if (!perfStatsEnabled())
    return;
  sendBridgeCommand('online.perf.interval', { value: next, target: currentBridgeTarget() }, 5000)
    .then(res => {
      if (res && res.failed && res.failed.length)
        onlineLog(panel, '性能采样间隔调整为 ' + next + 's（设备写入失败: ' + res.failed.join('/') + '）');
    })
    .catch(err => onlineLog(panel, '性能采样间隔调整为 ' + next + 's（在线下发失败: ' + err.message + '）'));
}

function updateOnlinePerf(panel, perf) {
  if (!perf) return;
  // Ignore records that raced the switch-off (e.g. already queued in
  // the websocket) while the bar shows the cleared state.
  if (!perfStatsEnabled()) return;
  const bar = ensureOnlinePerfBar(panel);
  const hint = bar.querySelector('[data-role=hint]');
  if (hint) hint.style.display = 'none';
  const num = (v, digits) => (v === null || v === undefined || isNaN(v))
    ? '--' : Number(v).toFixed(digits === undefined ? 1 : digits);
  bar.querySelector('[data-role=cpu]').textContent =
    'CPU ' + num(perf.cpu) + '% (均 ' + num(perf.cpu_avg) + ' / 峰 ' + num(perf.cpu_peak) + ')';
  bar.querySelector('[data-role=mem]').textContent =
    'MEM ' + formatPerfMem(perf.mem_kb) + ' (均 ' + formatPerfMem(perf.mem_avg_kb)
    + ' / 峰 ' + formatPerfMem(perf.mem_peak_kb) + ')';
  // An absent field (older board library) reads as 0: NPU unused.
  const npu = (perf.npu === null || perf.npu === undefined || isNaN(perf.npu))
    ? 0 : perf.npu;
  bar.querySelector('[data-role=npu]').textContent =
    'NPU ' + Math.round(npu) + '%';
  bar.querySelector('[data-role=rtf]').textContent = 'RTF ' + num(perf.rtf, 3);
  bar.querySelector('[data-role=time]').textContent =
    '运行 ' + num(perf.run_s, 1) + 's / 音频 ' + num(perf.audio_s, 1) + 's';
}

function handleOnlineBridgePerf(channel, perf) {
  const panel = state.onlinePanels[String(channel || '').toLowerCase()];
  if (panel) updateOnlinePerf(panel, perf);
}

function showOfflinePerf(channelKey, perf) {
  if (!perf) return;
  const status = document.getElementById('offStatus');
  if (!status) return;
  const num = (v, d) => (v === null || v === undefined || isNaN(v)) ? '--' : Number(v).toFixed(d);
  const parts = [channelKey.toUpperCase() + ' 完成'];
  if (perf.rtf !== undefined && perf.rtf !== null)
    parts.push('RTF ' + num(perf.rtf, 3));
  if (perf.cpu_avg !== null && perf.cpu_avg !== undefined)
    parts.push('CPU 均 ' + num(perf.cpu_avg, 1) + '% / 峰 ' + num(perf.cpu_peak, 1) + '%');
  if (perf.mem_avg_kb !== null && perf.mem_avg_kb !== undefined)
    parts.push('MEM 均 ' + formatPerfMem(perf.mem_avg_kb) + ' / 峰 ' + formatPerfMem(perf.mem_peak_kb));
  status.textContent = parts.join(' | ');
  const cpu = document.getElementById('offPerfCpu');
  const mem = document.getElementById('offPerfMem');
  const rtf = document.getElementById('offPerfRtf');
  const time = document.getElementById('offPerfTime');
  const hint = document.getElementById('offPerfHint');
  if (cpu) cpu.textContent = 'CPU 均 ' + num(perf.cpu_avg, 1)
    + '% / 峰 ' + num(perf.cpu_peak, 1) + '%';
  if (mem) mem.textContent = 'MEM 均 ' + formatPerfMem(perf.mem_avg_kb)
    + ' / 峰 ' + formatPerfMem(perf.mem_peak_kb);
  if (rtf) rtf.textContent = 'RTF ' + num(perf.rtf, 3);
  if (time) time.textContent = '计算 ' + num(perf.cost_s, 3)
    + 's / 音频 ' + num(perf.speech_s, 3) + 's';
  if (hint) hint.textContent = channelKey.toUpperCase() + ' 最近一次结果';
  log('性能统计: ' + parts.slice(1).join(', '), 'offLog');
}

function resetOfflinePerf(channelKey) {
  const values = [
    ['offPerfCpu', 'CPU --'], ['offPerfMem', 'MEM --'],
    ['offPerfRtf', 'RTF --'], ['offPerfTime', '--'],
  ];
  for (const item of values) {
    const el = document.getElementById(item[0]);
    if (el) el.textContent = item[1];
  }
  const hint = document.getElementById('offPerfHint');
  if (hint) hint.textContent = channelKey.toUpperCase() + ' 性能采样中…';
}

function bindLogFeatures(panel) {
  const state = attachLogFeatures(panel.refs.log, 'rockaa_online.log');
  panel._logState = state;
}

function attachLogFeatures(el, exportName) {
  if (!el || el._logFeaturesBound) return { paused: false, pending: [] };
  el._logFeaturesBound = true;
  let contextMenu = null;
  let lastFindText = '';
  const logState = { paused: false, pending: [] };

  function removeMenu() {
    if (contextMenu) { contextMenu.remove(); contextMenu = null; }
  }
  function restoreHighlight() {
    if (!el._highlighted) return;
    el.textContent = el.textContent;
    el._highlighted = false;
  }

  el.addEventListener('contextmenu', ev => {
    ev.preventDefault();
    ev.stopPropagation();
    removeMenu();
    contextMenu = document.createElement('div');
    contextMenu.className = 'log-context-menu';
    contextMenu.style.left = Math.min(ev.clientX, window.innerWidth - 170) + 'px';
    contextMenu.style.top = Math.min(ev.clientY, window.innerHeight - 140) + 'px';
    contextMenu.innerHTML = `
      <button class="log-menu-item" data-action="find">Find...</button>
      <button class="log-menu-item" data-action="export">Export Log...</button>
      <div class="log-menu-sep"></div>
      <button class="log-menu-item" data-action="copy-all">Copy All</button>
    `;
    const dismiss = function(ev) {
      if (!contextMenu) return;
      if (!contextMenu.contains(ev.target)) {
        removeMenu();
        document.removeEventListener('pointerdown', dismiss);
      }
    };
    const onMenuAction = menuEv => {
      const btn = menuEv.target.closest('[data-action]');
      if (!btn) return;
      const action = btn.dataset.action;
      removeMenu();
      document.removeEventListener('pointerdown', dismiss);
      if (action === 'find') {
        restoreHighlight();
        const text = prompt('Find text:', lastFindText);
        if (!text) return;
        lastFindText = text;
        const escaped = htmlEscape(el.textContent);
        const regex = new RegExp(escapeRegex(text), 'gi');
        if (!regex.test(escaped)) { alert('Text not found: ' + text); return; }
        regex.lastIndex = 0;
        el.innerHTML = escaped.replace(regex, '<mark class="log-highlight">$&</mark>');
        el._highlighted = true;
        const firstMark = el.querySelector('mark.log-highlight');
        if (firstMark) firstMark.scrollIntoView({block: 'center'});
      } else if (action === 'export') {
        const blob = new Blob([el.textContent], {type: 'text/plain'});
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = exportName;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        setTimeout(() => URL.revokeObjectURL(url), 100);
        showLogToast('Exported logs');
      } else if (action === 'copy-all') {
        const text = el.textContent;
        const done = () => showLogToast('Copied all of logs');
        if (navigator.clipboard && navigator.clipboard.writeText) {
          navigator.clipboard.writeText(text).then(done).catch(() => { fallbackCopy(text); done(); });
        } else { fallbackCopy(text); done(); }
      }
    };
    contextMenu.addEventListener('click', onMenuAction);
    document.body.appendChild(contextMenu);
    setTimeout(() => { document.addEventListener('pointerdown', dismiss); }, 0);
  });

  el.addEventListener('dblclick', ev => {
    if (ev.target.closest('.log-menu-item')) return;
    logState.paused = !logState.paused;
    el.classList.toggle('log-paused', logState.paused);
    if (!logState.paused) {
      restoreHighlight();
      const pending = logState.pending.splice(0);
      pending.forEach(line => appendLogLine(el, line));
      showLogToast('Resume logs');
    } else {
      showLogToast('Pause logs');
    }
  });

  return logState;
}

function escapeRegex(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function fallbackCopy(text) {
  const ta = document.createElement('textarea');
  ta.value = text;
  ta.style.position = 'fixed';
  ta.style.left = '-9999px';
  ta.style.top = '0';
  document.body.appendChild(ta);
  ta.focus();
  ta.select();
  try { document.execCommand('copy'); } catch (_) {}
  document.body.removeChild(ta);
}

function showLogToast(text) {
  const toast = document.createElement('div');
  toast.className = 'log-toast';
  toast.textContent = text;
  document.body.appendChild(toast);
  requestAnimationFrame(() => toast.classList.add('show'));
  setTimeout(() => {
    toast.classList.remove('show');
    setTimeout(() => toast.remove(), 300);
  }, 2200);
}

function bindLogSplitters() {
  document.querySelectorAll('.log-split-handle:not([data-bound])').forEach(handle => {
    handle.dataset.bound = '1';
    handle.addEventListener('pointerdown', e => {
      e.preventDefault();
      handle.setPointerCapture(e.pointerId);
      const parent = handle.parentElement;
      const log = parent.querySelector('.log');
      if (!log) return;
      const startY = e.clientY;
      const startH = log.getBoundingClientRect().height;

      const onMove = ev => {
        const dy = ev.clientY - startY;
        const newH = Math.max(40, startH - dy);
        log.style.height = newH + 'px';
      };
      const onUp = () => {
        handle.removeEventListener('pointermove', onMove);
        handle.removeEventListener('pointerup', onUp);
      };
      handle.addEventListener('pointermove', onMove);
      handle.addEventListener('pointerup', onUp);
    });
  });
}

function startOnline(ch) {
  if (!ch) {
    const txPanel = ensureOnlinePanel('tx');
    const rxPanel = ensureOnlinePanel('rx');
    [txPanel, rxPanel].forEach(panel => {
      const wasOpen = panel.root.classList.contains('open');
      refreshOnlinePanelLanguage(panel);
      panel.root.classList.add('open');
      renderOnlineDeviceSettings(panel);
      configureOnlineWaveforms(panel);
      onlineLog(panel, '打开在线仿真对话框');
      if (panel.key === 'rx') loadBrowserCaptureDevices(panel);
      if (!wasOpen && !panel.running)
        maybeAutoStartOnline(panel);
    });
    layoutOnlinePanels();
    bringOnlinePanelToFront(txPanel);
    updateGlobalOnlineState();
    return;
  }
  const panel = ensureOnlinePanel(ch || currentChannel);
  const wasOpen = panel.root.classList.contains('open');
  refreshOnlinePanelLanguage(panel);
  panel.root.classList.add('open');
  layoutOnlinePanels();
  bringOnlinePanelToFront(panel);
  renderOnlineDeviceSettings(panel);
  configureOnlineWaveforms(panel);
  onlineLog(panel, '打开在线仿真对话框');
  if (panel.key === 'rx') loadBrowserCaptureDevices(panel);
  if (!wasOpen && !panel.running)
    maybeAutoStartOnline(panel);
}

function closeOnlineDialog(ch) {
  if (!ch) {
    Object.values(onlinePanels).forEach(panel => {
      if (panel.root.classList.contains('open')) {
        stopOnlineStream(panel.key);
        panel.root.classList.remove('open');
      }
    });
    layoutOnlinePanels();
    updateGlobalOnlineState();
    return;
  }
  const panel = ensureOnlinePanel(ch || state.onlineChannel);
  stopOnlineStream(panel.key);
  panel.root.classList.remove('open');
  layoutOnlinePanels();
  updateGlobalOnlineState();
}

function resetOnlinePanelBuffers(panel) {
  const config = onlineChannelConfigFor(panel.key);
  panel.rollingInput = {
    samples: [],
    channels: config.inputChannels,
    sampleRate: config.sampleRate,
  };
  panel.rollingOutput = {
    samples: [],
    channels: config.outputChannels,
    sampleRate: config.sampleRate,
  };
  panel.inputWave.channelIndex = 0;
  panel.outputWave.channelIndex = 0;
}

function startOnlineStream(ch) {
  const panel = ensureOnlinePanel(ch || state.onlineChannel);
  if (panel.running || panel.starting) return;
  if (panel.key === 'rx' && !rxOnlineSourceReady(panel)) {
    onlineLog(panel, 'RX 在线仿真需要先导入 RX 音源或开启主机录音');
    panel.refs.status.textContent = t('ready');
    return;
  }
  if (!state.config[panel.key]) {
    failOnlineStream(panel, t('no_config'));
    return;
  }
  panel.running = true;
  panel.starting = true;
  panel.stopRequested = false;
  panel.paused = false;
  stopBrowserPlayback(panel);
  stopBrowserRecord(panel);
  resetOnlinePanelBuffers(panel);
  resetSedEventCounters(panel);
  rebuildOnlineHostPlaybackChoices(panel);
  panel.refs.status.textContent = t('running');
  panel.refs.start.disabled = true;
  panel.refs.stop.disabled = false;
  onlineLog(panel, '启动在线仿真 (WebSocket 连接...)');
  updateGlobalOnlineState();
  tryConnectStream(panel);
}

function failOnlineStream(panel, message) {
  onlineLog(panel, message);
  panel.running = false;
  panel.starting = false;
  stopBrowserRecord(panel);
  rejectOnlineSourceRequests(panel, message);
  panel.refs.status.textContent = message;
  panel.refs.start.disabled = false;
  panel.refs.stop.disabled = true;
  if (panel.ws) {
    panel.ws.close();
    panel.ws = null;
  }
  updateGlobalOnlineState();
}

function finishOnlineStartup(panel) {
  panel.starting = false;
  if (panel.stopRequested) {
    panel.stopRequested = false;
    stopOnlineStream(panel.key);
    return true;
  }
  if (panel.restartRequested) {
    const reason = panel.restartReason;
    panel.restartRequested = false;
    panel.restartReason = '';
    if (panel.running) {
      queueOnlineRestart(panel, reason || '在线仿真参数变化');
    } else {
      panel.restartTimer = setTimeout(() => {
        panel.restartTimer = null;
        startOnlineStream(panel.key);
      }, 800);
    }
    return true;
  }
  return false;
}

function chooseSedModelForTx(panel) {
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = '.rknn';
  input.onchange = () => {
    const file = input.files && input.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      const result = String(reader.result || '');
      const comma = result.indexOf(',');
      const base64 = comma >= 0 ? result.slice(comma + 1) : '';
      if (!base64) {
        if (panel) onlineLog(panel, 'SED rknn 模型读取失败: ' + file.name);
        return;
      }
      state.sedModel = { name: file.name, base64 };
      state.sedAuto = false;
      refreshDeviceSettingsUi();
      Object.values(onlinePanels).forEach(updateSedModelLabel);
      if (panel) onlineLog(panel, 'SED rknn 模型已导入: ' + file.name
        + ' (' + Math.round(file.size / 1024) + ' KB)，下次启动在线仿真时生效');
    };
    reader.onerror = () => {
      if (panel) onlineLog(panel, 'SED rknn 模型读取失败: ' + file.name);
    };
    reader.readAsDataURL(file);
  };
  input.click();
}

function chooseSedModel(panel) {
  chooseSedModelForTx(panel);
}

function clearSedModelForTx(panel) {
  state.sedModel = null;
  state.sedAuto = false;
  refreshDeviceSettingsUi();
  Object.values(onlinePanels).forEach(updateSedModelLabel);
  if (panel) onlineLog(panel, 'SED rknn 模型已清除，下次启动在线仿真时关闭 SED');
}

function useAutoSedModelForTx(panel) {
  state.sedModel = null;
  state.sedAuto = true;
  refreshDeviceSettingsUi();
  Object.values(onlinePanels).forEach(updateSedModelLabel);
  if (panel) onlineLog(panel, 'SED 将在下次启动在线仿真时自动匹配平台模型');
}

function updateSedModelLabel(panel) {
  if (!panel.refs.sedName) return;
  panel.refs.sedName.textContent = state.sedModel
    ? state.sedModel.name
    : state.sedAuto ? t('sed_model_auto_active') : t('sed_model_none');
  if (panel.refs.sedClear) panel.refs.sedClear.disabled = !state.sedModel && !state.sedAuto;
}

function flashSedBabyBadge(panel) {
  if (!panel.refs.sedBaby) return;
  panel.refs.sedBaby.textContent = t('sed_babycry_detected');
  panel.refs.sedBaby.style.display = '';
  if (panel.sedBabyTimer) clearTimeout(panel.sedBabyTimer);
  panel.sedBabyTimer = setTimeout(() => {
    if (panel.refs.sedBaby) panel.refs.sedBaby.style.display = 'none';
    panel.sedBabyTimer = null;
  }, 5000);
}

function resetSedEventCounters(panel) {
  panel.sedBcdCount = 0;
  panel.sedBuzCount = 0;
  panel.sedGbsCount = 0;
  panel.sedSpans = [];
  if (panel.outputWave) panel.outputWave.eventSpans = [];
  if (panel.inputWave) panel.inputWave.eventSpans = [];
  if (panel.refs.sedBaby) panel.refs.sedBaby.style.display = 'none';
  if (panel.sedBabyTimer) {
    clearTimeout(panel.sedBabyTimer);
    panel.sedBabyTimer = null;
  }
}

function renderSedEventCounters(panel) {
  if (!panel.refs.sedName) return;
  panel.refs.sedName.textContent =
    (state.sedModel ? state.sedModel.name : t('sed_model_auto_active'))
    + ' | bcd:' + (panel.sedBcdCount || 0)
    + ' buz:' + (panel.sedBuzCount || 0)
    + ' gbs:' + (panel.sedGbsCount || 0);
}

function parseOnlineSedLog(message) {
  const text = String(message || '');
  const events = [];
  const eventRe = /sed event - babycry: (\d+), buzzer: (\d+), glassbreaking: (\d+)(?:[^\r\n]*?t:\s*([\d.]+)s)?/g;
  for (const match of text.matchAll(eventRe)) {
    events.push({
      bcd: Number(match[1]),
      buz: Number(match[2]),
      gbs: Number(match[3]),
      time: match[4] === undefined ? null : Number(match[4]),
    });
  }
  const match = text.match(/sed events: babycry:(\d+) buzzer:(\d+) glassbreaking:(\d+)/);
  return {
    events,
    summary: match ? { bcd: Number(match[1]), buz: Number(match[2]), gbs: Number(match[3]) } : null,
  };
}

// The HAL timestamp marks the end of a 256-sample SED frame. Convert it to
// [start, end] so the overlay matches sed_main's third output channel exactly.
function appendSedEventSpan(panel, tSec) {
  if (!Number.isFinite(tSec)) return;
  const frameSec = 0.016;
  const t0 = Math.max(0, tSec - frameSec);
  panel.sedSpans = panel.sedSpans || [];
  const last = panel.sedSpans[panel.sedSpans.length - 1];
  if (last && t0 - last.t1 <= frameSec * 0.5) {
    last.t1 = tSec;
  } else {
    panel.sedSpans.push({ t0, t1: tSec });
  }
  if (panel.outputWave) panel.outputWave.eventSpans = panel.sedSpans;
  if (panel.inputWave) panel.inputWave.eventSpans = panel.sedSpans;
}

function rxSourcePayload(panel, channelConfig) {
  if (panel.key !== 'rx') return undefined;
  if (panel.hostRecord) {
    return {
      mode: 'browser-record',
      channels: Number(channelConfig.inputChannels) || panel.browserRecordChannels,
      playbackOn: !panel.refs.rxPlayback || panel.refs.rxPlayback.value === 'on',
    };
  }
  if (panel.rxSource) {
    const { base64, ...source } = panel.rxSource;
    return Object.assign({ mode: 'browser-file',
      playbackOn: panel.refs.rxPlayback && panel.refs.rxPlayback.value === 'on' }, source);
  }
  return { mode: 'none' };
}

async function tryConnectStream(panel) {
  const config = state.config[panel.key] || null;
  try {
    await ensureBridgeReady();
  } catch (err) {
    failOnlineStream(panel, '在线仿真失败: ' + err.message);
    return;
  }

  const sourceChannelConfig = typeof onlineChannelConfigFor === 'function'
    ? onlineChannelConfigFor(panel.key)
    : undefined;
  const channelConfig = sourceChannelConfig;
  const rxSource = rxSourcePayload(panel, sourceChannelConfig || {});

  try {
    if (typeof validateImportedConfigVersion === 'function')
      await validateImportedConfigVersion(panel.key, state.configVersion[panel.key]);
    const started = await sendBridgeCommand('online.start', {
      channel: panel.channel,
      version: state.configVersion[panel.key],
      config,
      channelConfig,
      rxSource,
      sedModel: panel.key === 'tx' && state.sedModel
        ? { name: state.sedModel.name, base64: state.sedModel.base64 }
        : undefined,
      sedAuto: panel.key === 'tx' && state.sedAuto,
      perfInterval: perfInterval(),
      perfEnabled: perfStatsEnabled(),
      playback: { stream: '', channel: 0 },
      target: currentBridgeTarget(),
    }, 180000);
    if (started && started.localPorts)
      onlineLog(panel, `Bridge 本地端口: ${started.localPorts.in}/${started.localPorts.out}/${started.localPorts.source}`);
    onlineLog(panel, 'Bridge 已启动在线仿真: ' + panel.channel);
    if (perfStatsEnabled())
      setOnlinePerfHint(panel, '采样中（每 ' + perfInterval() + 's 刷新）…');
    else
      setOnlinePerfHint(panel, t('perf_stats_hint_off'));
  } catch (err) {
    failOnlineStream(panel, 'Bridge 在线启动失败: ' + err.message);
    finishOnlineStartup(panel);
    return;
  }

  if (finishOnlineStartup(panel))
    return;

  const streamUrl = state.bridge.url || BRIDGE_URLS[0];
  try {
    const streamSocket = new WebSocket(streamUrl);
    panel.ws = streamSocket;
    panel.ws.binaryType = 'arraybuffer';
    panel.ws.onopen = () => {
      onlineLog(panel, '在线流 WebSocket 已连接: ' + streamUrl);
      panel.ws.send(JSON.stringify({ cmd: 'online.stream.attach', channel: panel.channel }));
    };
    panel.ws.onmessage = ev => {
      if (typeof ev.data === 'string') {
        const msg = JSON.parse(ev.data);
        if (msg.id && panel.sourceRequests && panel.sourceRequests.has(msg.id)) {
          const pending = panel.sourceRequests.get(msg.id);
          clearTimeout(pending.timer);
          panel.sourceRequests.delete(msg.id);
          if (msg.ok === false || msg.error) pending.reject(new Error(msg.error || 'RX 音源传输失败'));
          else pending.resolve(msg.result || {});
          return;
        }
        if (msg.type === 'log') {
          onlineLog(panel, msg.message || '');
          const exited = String(msg.message || '').match(/rockaa_(?:capt|play) exited:\s*(-?\d+)/);
          if (exited)
            setOnlinePerfHint(panel,
              '会话已退出（exit ' + exited[1] + '）——性能数据停止，原因见下方日志');
          const sedEnabled = state.sedModel || state.sedAuto;
          const sedLog = parseOnlineSedLog(msg.message);
          for (const sedEvt of sedLog.events) {
            if (!sedEnabled) break;
            panel.sedBcdCount = (panel.sedBcdCount || 0) + (sedEvt.bcd === 1 ? 1 : 0);
            panel.sedBuzCount = (panel.sedBuzCount || 0) + (sedEvt.buz === 1 ? 1 : 0);
            panel.sedGbsCount = (panel.sedGbsCount || 0) + (sedEvt.gbs === 1 ? 1 : 0);
            if (sedEvt.bcd === 1) {
              flashSedBabyBadge(panel);
              appendSedEventSpan(panel, sedEvt.time);
            }
          }
          if (sedLog.events.length && sedEnabled) renderSedEventCounters(panel);
          if (sedLog.summary && sedEnabled) {
            panel.sedBcdCount = sedLog.summary.bcd;
            panel.sedBuzCount = sedLog.summary.buz;
            panel.sedGbsCount = sedLog.summary.gbs;
            renderSedEventCounters(panel);
          }
          return;
        }
        if (msg.type === 'online.perf') {
          updateOnlinePerf(panel, msg.perf || {});
          return;
        }
        if (msg.type === 'error') {
          failOnlineStream(panel, '在线流不可用: ' + (msg.message || 'stream attach failed'));
          return;
        }
        if (msg.type === 'online.source.ready') {
          startBrowserRecord(panel);
          return;
        }
        if (msg.type === 'online.source.upload') {
          startRxSourceUpload(panel);
          return;
        }
        if (msg.type === 'input') appendStream(panel, panel.rollingInput, msg.data || [], msg.channels, msg.sampleRate, 'input');
        if (msg.type === 'output') appendStream(panel, panel.rollingOutput, msg.data || [], msg.channels, msg.sampleRate, 'output');
      } else {
        appendStream(panel, panel.rollingInput, decodePcm16(ev.data),
          panel.rollingInput.channels, panel.rollingInput.sampleRate, 'input');
      }
    };
    panel.ws.onerror = () => failOnlineStream(panel, '在线流连接失败');
    panel.ws.onclose = () => {
      if (panel.ws !== streamSocket) return;
      stopBrowserRecord(panel);
      rejectOnlineSourceRequests(panel, 'RX 音源在线流已断开');
      onlineLog(panel, '在线流 WebSocket 断开');
      if (panel.running && !panel.stopRequested)
        failOnlineStream(panel, '在线流已断开，请确认设备和 Bridge 后重新开始');
    };
  } catch(e) {
    failOnlineStream(panel, 'WebSocket 不可用: ' + e.message);
  }
}

function decodePcm16(buffer) {
  const view = ArrayBuffer.isView(buffer)
    ? new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength)
    : new DataView(buffer);
  const samples = new Array(Math.floor(view.byteLength / 2));
  for (let i = 0; i < samples.length; i++)
    samples[i] = view.getInt16(i * 2, true) / 32768.0;
  return samples;
}

function writeAscii(view, offset, text) {
  for (let i = 0; i < text.length; i++) view.setUint8(offset + i, text.charCodeAt(i));
}

function wavBlobFromFloat(samples, channels, sampleRate) {
  const bytesPerSample = 2;
  const dataBytes = samples.length * bytesPerSample;
  const buffer = new ArrayBuffer(44 + dataBytes);
  const view = new DataView(buffer);
  writeAscii(view, 0, 'RIFF');
  view.setUint32(4, 36 + dataBytes, true);
  writeAscii(view, 8, 'WAVE');
  writeAscii(view, 12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, channels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * channels * bytesPerSample, true);
  view.setUint16(32, channels * bytesPerSample, true);
  view.setUint16(34, 16, true);
  writeAscii(view, 36, 'data');
  view.setUint32(40, dataBytes, true);
  for (let i = 0; i < samples.length; i++) {
    const sample = clamp(samples[i], -1, 1);
    view.setInt16(44 + i * 2, sample < 0 ? sample * 32768 : sample * 32767, true);
  }
  return new Blob([buffer], { type: 'audio/wav' });
}

function downloadBlob(fileName, blob) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = fileName;
  a.click();
  URL.revokeObjectURL(a.href);
}

function trimRollingBuffer(panel, stream) {
  const sr = stream.sampleRate || 16000;
  const cacheSec = panel.refs.unlimited.checked
    ? Math.max(10, stream.samples.length / Math.max(1, stream.channels) / sr + 1)
    : Math.max(1, Number(panel.refs.cache.value) || 10);
  const maxSamples = sr * cacheSec * Math.max(1, stream.channels);
  if (stream.samples.length > maxSamples) {
    const dropped = stream.samples.length - maxSamples;
    stream.samples.splice(0, dropped);
    // Track the absolute audio time carried by the window start so SED
    // event spans (absolute timestamps) stay aligned on the rolling view.
    stream.originSec = (stream.originSec || 0)
      + dropped / (sr * Math.max(1, stream.channels));
  }
}

function refreshOnlineWaveforms(panel) {
  panel.inputWave.samples = panel.rollingInput.samples;
  panel.inputWave.channels = panel.rollingInput.channels;
  panel.inputWave.sampleRate = panel.rollingInput.sampleRate;
  panel.inputWave.eventOriginSec = panel.rollingInput.originSec || 0;
  panel.outputWave.samples = panel.rollingOutput.samples;
  panel.outputWave.channels = panel.rollingOutput.channels;
  panel.outputWave.sampleRate = panel.rollingOutput.sampleRate;
  panel.outputWave.eventOriginSec = panel.rollingOutput.originSec || 0;
  renderChannelTabs(panel.refs.inputTabs, panel.inputWave, panel.rollingInput.channels, 'ch');
  renderChannelTabs(panel.refs.outputTabs, panel.outputWave, panel.rollingOutput.channels, 'ch');
  rebuildOnlineHostPlaybackChoices(panel);
  const inSec = panel.rollingInput.samples.length / Math.max(1, panel.rollingInput.channels) / panel.rollingInput.sampleRate;
  const outSec = panel.rollingOutput.samples.length / Math.max(1, panel.rollingOutput.channels) / panel.rollingOutput.sampleRate;
  panel.refs.inputInfo.textContent =
    `Input: ${inSec.toFixed(1)}s | ${panel.rollingInput.channels}ch | ${panel.rollingInput.sampleRate / 1000}kHz`;
  panel.refs.outputInfo.textContent =
    `Output: ${outSec.toFixed(1)}s | ${panel.rollingOutput.channels}ch | ${panel.rollingOutput.sampleRate / 1000}kHz`;
}

function appendStream(panel, stream, samples, channels, sampleRate, kind) {
  stream.channels = channels || stream.channels || 1;
  stream.sampleRate = sampleRate || stream.sampleRate || 16000;
  feedBrowserPlayback(panel, kind, samples, stream.channels, stream.sampleRate);
  stream.samples.push(...samples);
  trimRollingBuffer(panel, stream);
  refreshOnlineWaveforms(panel);
}

function stopOnlineStream(ch) {
  const panel = ensureOnlinePanel(ch || state.onlineChannel);
  if (panel.starting) {
    panel.stopRequested = true;
    panel.restartRequested = false;
    onlineLog(panel, '在线启动仍在进行，等待启动返回后停止');
    return;
  }
  if (panel.restartTimer) {
    clearTimeout(panel.restartTimer);
    panel.restartTimer = null;
  }
  panel.running = false;
  panel.starting = false;
  panel.paused = false;
  stopBrowserPlayback(panel);
  stopBrowserRecord(panel);
  rejectOnlineSourceRequests(panel, 'RX 音源在线流已停止');
  if (panel.ws) { panel.ws.close(); panel.ws = null; }
  if (bridgeIsOpen())
    sendBridgeCommand('online.stop', { channel: panel.channel, target: currentBridgeTarget() })
      .catch(err => onlineLog(panel, '停止在线仿真失败: ' + err.message));
  panel.refs.status.textContent = t('stopped');
  panel.refs.start.disabled = false;
  panel.refs.stop.disabled = true;
  setOnlinePerfHint(panel, onlinePerfHintIdle());
  updateGlobalOnlineState();
}

function stopOnline(ch) {
  stopOnlineStream(ch);
}

function toggleOnlinePause(ch) {
  const panel = ensureOnlinePanel(ch || state.onlineChannel);
  panel.paused = !panel.paused;
  panel.refs.pause.textContent = panel.paused ? t('online_resume') : t('online_pause');
  panel.refs.status.textContent = panel.paused ? t('paused') : t('running');
  updateGlobalOnlineState();
}

async function exportOnlineAudio(ch) {
  const panel = ensureOnlinePanel(ch || state.onlineChannel);
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const blobs = [];
  if (panel.rollingInput.samples.length) {
    blobs.push({
      name: `online_${panel.key}_${stamp}_input.wav`,
      blob: wavBlobFromFloat(panel.rollingInput.samples, panel.rollingInput.channels, panel.rollingInput.sampleRate),
    });
  }
  if (panel.rollingOutput.samples.length) {
    blobs.push({
      name: `online_${panel.key}_${stamp}_output.wav`,
      blob: wavBlobFromFloat(panel.rollingOutput.samples, panel.rollingOutput.channels, panel.rollingOutput.sampleRate),
    });
  }
  if (!blobs.length) {
    alert('当前没有可导出的在线音频缓存');
    return;
  }

  if (typeof window.showDirectoryPicker === 'function') {
    try {
      const dir = await window.showDirectoryPicker({ mode: 'readwrite' });
      for (const { name, blob } of blobs) {
        const handle = await dir.getFileHandle(name, { create: true });
        const writable = await handle.createWritable();
        await writable.write(blob);
        await writable.close();
      }
      onlineLog(panel, '已导出在线音频缓存到目录: ' + blobs.length + ' 个 WAV');
      showLogToast('Exported ' + blobs.length + ' WAV(s)');
    } catch (err) {
      if (err.name !== 'AbortError')
        onlineLog(panel, '导出失败: ' + err.message);
    }
    return;
  }

  blobs.forEach(({ name, blob }) => downloadBlob(name, blob));
  onlineLog(panel, '已导出在线音频缓存: ' + blobs.length + ' 个 WAV');
}

function arrayBufferToBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    const chunk = bytes.subarray(offset, offset + 0x8000);
    binary += String.fromCharCode.apply(null, chunk);
  }
  return btoa(binary);
}

// ── raw/PCM import dialog ──
let rawImportResolver = null;
let rawImportContext = null;
let rawImportBound = false;

const RAW_BYTES_PER_SAMPLE = { s8: 1, s16le: 2, s24le: 3, s32le: 4, f32le: 4 };

function isWavBuffer(buffer) {
  return buffer.byteLength >= 44 &&
    new DataView(buffer).getUint32(0, false) === 0x52494646; // 'RIFF'
}

function parseWavToFloat(buffer) {
  const view = new DataView(buffer);
  if (!isWavBuffer(buffer)) return null;
  const channels = view.getUint16(22, true);
  const sampleRate = view.getUint32(24, true);
  const bitsPerSample = view.getUint16(34, true);
  let dataOffset = 44, dataLen = buffer.byteLength - 44;
  let offset = 12;
  while (offset < buffer.byteLength - 8) {
    const id = view.getUint32(offset, false);
    const sz = view.getUint32(offset + 4, true);
    if (id === 0x64617461) { dataOffset = offset + 8; dataLen = Math.min(sz, buffer.byteLength - dataOffset); break; }
    offset += 8 + sz;
  }
  const bytesPerSample = bitsPerSample / 8;
  const numSamples = Math.floor(dataLen / bytesPerSample);
  const samples = new Array(numSamples);
  for (let i = 0; i < numSamples; i++) {
    const off = dataOffset + i * bytesPerSample;
    if (bitsPerSample === 16 && off + 2 <= buffer.byteLength) samples[i] = view.getInt16(off, true) / 32768.0;
    else if (bitsPerSample === 32 && off + 4 <= buffer.byteLength) samples[i] = view.getInt32(off, true) / 2147483648.0;
    else if (bitsPerSample === 8 && off + 1 <= buffer.byteLength) samples[i] = (view.getUint8(off) - 128) / 128.0;
    else samples[i] = 0;
  }
  return { samples, channels, sampleRate, bitsPerSample };
}

function detectRawParamsFromName(fileName) {
  const result = {};
  const lower = (fileName || '').toLowerCase();
  const chMatch = lower.match(/(\d+)\s*ch/) || lower.match(/(\d+)\s*channel/);
  if (chMatch) {
    const n = parseInt(chMatch[1], 10);
    if (n > 0 && n <= 32) result.channels = n;
  }
  const knownRates = [96000, 48000, 44100, 32000, 24000, 16000, 8000];
  for (const r of knownRates) {
    if (lower.indexOf(String(r)) !== -1) { result.sampleRate = r; break; }
  }
  if (!result.sampleRate) {
    const kMatch = lower.match(/(\d{1,2})k\b/);
    if (kMatch) {
      const v = parseInt(kMatch[1], 10) * 1000;
      if (knownRates.indexOf(v) !== -1) result.sampleRate = v;
    }
  }
  return result;
}

function decodeRawPcm(buffer, opts) {
  const view = new DataView(buffer);
  const le = opts.byteOrder !== 'be';
  const channels = Math.max(1, opts.channels);
  const bytesPerSample = RAW_BYTES_PER_SAMPLE[opts.encoding] || 2;
  let readFn;
  switch (opts.encoding) {
    case 's8':
      readFn = o => (view.getUint8(o) - 128) / 128;
      break;
    case 's24le':
      readFn = o => {
        const b0 = view.getUint8(o), b1 = view.getUint8(o + 1), b2 = view.getUint8(o + 2);
        let v = le ? (b2 << 16) | (b1 << 8) | b0 : (b0 << 16) | (b1 << 8) | b2;
        if (v & 0x800000) v |= ~0xffffff;
        return v / 8388608;
      };
      break;
    case 's32le':
      readFn = o => view.getInt32(o, le) / 2147483648;
      break;
    case 'f32le':
      readFn = o => view.getFloat32(o, le);
      break;
    default: // s16le
      readFn = o => view.getInt16(o, le) / 32768;
  }
  const startOffset = Math.max(0, opts.startOffset || 0);
  const amountPct = Math.min(100, Math.max(1, opts.amountPct || 100));
  const availBytes = Math.max(0, buffer.byteLength - startOffset);
  const useBytes = Math.floor(availBytes * amountPct / 100);
  const frameSize = bytesPerSample * channels;
  const frames = frameSize > 0 ? Math.floor(useBytes / frameSize) : 0;
  const numSamples = frames * channels;
  const samples = new Array(numSamples);
  for (let i = 0; i < numSamples; i++) {
    const off = startOffset + i * bytesPerSample;
    if (off + bytesPerSample > buffer.byteLength) { samples[i] = 0; continue; }
    samples[i] = readFn(off);
  }
  return { samples, channels, sampleRate: opts.sampleRate, bytesPerSample };
}

function floatToPcm16Base64(samples) {
  const buf = new ArrayBuffer(samples.length * 2);
  const view = new DataView(buf);
  for (let i = 0; i < samples.length; i++) {
    const s = samples[i] < -1 ? -1 : samples[i] > 1 ? 1 : samples[i];
    view.setInt16(i * 2, s < 0 ? s * 32768 : s * 32767, true);
  }
  return arrayBufferToBase64(buf);
}

function collectRawImportOpts() {
  const encoding = document.getElementById('rawEncoding').value;
  return {
    encoding,
    bytesPerSample: RAW_BYTES_PER_SAMPLE[encoding] || 2,
    byteOrder: document.getElementById('rawByteOrder').value,
    channels: parseInt(document.getElementById('rawChannels').value, 10) || 1,
    startOffset: parseInt(document.getElementById('rawStartOffset').value, 10) || 0,
    amountPct: parseInt(document.getElementById('rawAmount').value, 10) || 100,
    sampleRate: parseInt(document.getElementById('rawSampleRate').value, 10) || 16000,
  };
}

function setRawSelectValue(id, val) {
  const sel = document.getElementById(id);
  if (!sel) return;
  for (const opt of sel.options) {
    if (Number(opt.value) === Number(val)) { sel.value = opt.value; return; }
  }
}

function updateRawImportPreview() {
  if (!rawImportContext) return;
  const opts = collectRawImportOpts();
  const frameSize = opts.bytesPerSample * opts.channels;
  const availBytes = Math.max(0, rawImportContext.buffer.byteLength - opts.startOffset);
  const useBytes = Math.floor(availBytes * opts.amountPct / 100);
  const frames = frameSize > 0 ? Math.floor(useBytes / frameSize) : 0;
  const seconds = opts.sampleRate > 0 ? frames / opts.sampleRate : 0;
  document.getElementById('rawImportPreview').textContent =
    `${frames} frames · ${opts.channels}ch · ${opts.sampleRate}Hz · ${seconds.toFixed(2)}s · ${opts.encoding}`;
}

function bindRawImportControls() {
  if (rawImportBound) return;
  rawImportBound = true;
  ['rawEncoding', 'rawByteOrder', 'rawChannels', 'rawStartOffset', 'rawAmount', 'rawSampleRate']
    .forEach(id => {
      const el = document.getElementById(id);
      if (!el) return;
      el.addEventListener('change', updateRawImportPreview);
      if (el.tagName === 'INPUT') el.addEventListener('input', updateRawImportPreview);
    });
}

function showRawImportDialog(buffer, fileName, fallbackChannels, fallbackSampleRate) {
  return new Promise(resolve => {
    rawImportResolver = resolve;
    rawImportContext = { buffer, fileName };
    bindRawImportControls();
    const det = detectRawParamsFromName(fileName);
    setRawSelectValue('rawChannels', det.channels || fallbackChannels || 1);
    setRawSelectValue('rawSampleRate', det.sampleRate || fallbackSampleRate || 16000);
    document.getElementById('rawStartOffset').value = 0;
    document.getElementById('rawAmount').value = 100;
    document.getElementById('rawEncoding').value = 's16le';
    document.getElementById('rawByteOrder').value = 'le';
    document.getElementById('rawImportTitle').textContent = t('raw_import_title') + ': ' + fileName;
    updateRawImportPreview();
    document.getElementById('rawImportDialog').classList.add('open');
  });
}

function detectRawParams() {
  if (!rawImportContext) return;
  const det = detectRawParamsFromName(rawImportContext.fileName);
  if (det.channels) setRawSelectValue('rawChannels', det.channels);
  if (det.sampleRate) setRawSelectValue('rawSampleRate', det.sampleRate);
  updateRawImportPreview();
}

function confirmRawImport() {
  if (!rawImportContext) return;
  const opts = collectRawImportOpts();
  const result = decodeRawPcm(rawImportContext.buffer, opts);
  document.getElementById('rawImportDialog').classList.remove('open');
  const resolve = rawImportResolver;
  rawImportResolver = null;
  rawImportContext = null;
  if (resolve) resolve(result);
}

function closeRawImportDialog() {
  document.getElementById('rawImportDialog').classList.remove('open');
  const resolve = rawImportResolver;
  rawImportResolver = null;
  rawImportContext = null;
  if (resolve) resolve(null);
}

function parseSourceAudioBuffer(buffer, fallbackChannels) {
  const view = new DataView(buffer);
  let channels = fallbackChannels || 2;
  let sampleRate = 16000;
  let bitsPerSample = 16;
  let dataOffset = 0;
  let dataLen = buffer.byteLength;
  let format = 'Raw PCM';
  if (buffer.byteLength >= 44 && view.getUint32(0, false) === 0x52494646) {
    format = 'WAV';
    channels = view.getUint16(22, true);
    sampleRate = view.getUint32(24, true);
    bitsPerSample = view.getUint16(34, true);
    let offset = 12;
    while (offset < buffer.byteLength - 8) {
      const id = view.getUint32(offset, false);
      const sz = view.getUint32(offset + 4, true);
      if (id === 0x64617461) {
        dataOffset = offset + 8;
        dataLen = Math.min(sz, buffer.byteLength - dataOffset);
        break;
      }
      offset += 8 + sz;
    }
  }
  if (bitsPerSample !== 16)
    throw new Error('RX 在线仿真当前仅支持 16-bit PCM 音源');
  const frameBytes = Math.max(1, channels) * 2;
  dataLen -= dataLen % frameBytes;
  if (!dataLen)
    throw new Error('RX 在线仿真音源不包含完整 PCM 帧');
  const pcm = buffer.slice(dataOffset, dataOffset + dataLen);
  return {
    base64: arrayBufferToBase64(pcm),
    channels,
    sampleRate,
    bitsPerSample,
    bytes: dataLen,
    seconds: dataLen / Math.max(1, channels) / 2 / Math.max(1, sampleRate),
    format,
  };
}

function chooseRxSource(panel) {
  pendingRxSourcePanel = panel;
  document.getElementById('fileRxSource').click();
}

document.getElementById('fileRxSource').addEventListener('change', e => {
  const file = e.target.files[0];
  const panel = pendingRxSourcePanel;
  pendingRxSourcePanel = null;
  if (!file || !panel) return;
  const reader = new FileReader();
  reader.onload = async ev => {
    try {
      const buf = ev.target.result;
      const config = onlineChannelConfigFor('rx');
      let source;
      if (isWavBuffer(buf)) {
        source = parseSourceAudioBuffer(buf, config.inputChannels);
      } else {
        const result = await showRawImportDialog(buf, file.name, config.inputChannels, 16000);
        if (!result) return;
        source = {
          base64: floatToPcm16Base64(result.samples),
          channels: result.channels,
          sampleRate: result.sampleRate,
          bitsPerSample: 16,
          bytes: result.samples.length * 2,
          seconds: result.samples.length / Math.max(1, result.channels) / Math.max(1, result.sampleRate),
          format: 'Raw PCM',
        };
      }
      source.channels = syncRxSourceChannels(panel, source.channels);
      panel.rxSource = Object.assign({ fileName: file.name }, source);
      panel.browserProbeToken = (panel.browserProbeToken || 0) + 1;
      panel.hostRecord = false;
      if (panel.refs.hostRecord) panel.refs.hostRecord.textContent = 'off';
      if (panel.refs.rxPlayback) panel.refs.rxPlayback.value = 'on';
      updateRxSourceLabel(panel);
      onlineLog(panel, `导入 RX 音源: ${file.name}, ${source.channels}ch`);
      restartRxOnlineSource(panel, 'RX 音源已更新');
    } catch (err) {
      alert('导入 RX 音源失败: ' + err.message);
    }
  };
  reader.readAsArrayBuffer(file);
  e.target.value = '';
});

async function toggleRxHostRecord(panel) {
  if (panel.hostRecord) {
    panel.hostRecord = false;
    panel.browserProbeToken = (panel.browserProbeToken || 0) + 1;
    panel.refs.hostRecord.textContent = 'off';
    updateRxSourceLabel(panel);
    restartRxOnlineSource(panel, 'RX 当前浏览器录音: off');
    return;
  }

  panel.hostRecord = true;
  panel.refs.hostRecord.textContent = 'on';
  panel.rxSource = null;
  updateRxSourceLabel(panel);
  if (panel.refs.rxPlayback) panel.refs.rxPlayback.value = 'on';
  try {
    await loadBrowserCaptureDevices(panel);
    const channels = await prepareBrowserRecordChannels(panel);
    if (!panel.hostRecord || !channels) return;
    restartRxOnlineSource(panel, `RX 当前浏览器录音: on (${channels}ch)`);
  } catch (err) {
    if (!panel.hostRecord) return;
    panel.hostRecord = false;
    panel.refs.hostRecord.textContent = 'off';
    updateRxSourceLabel(panel);
    onlineLog(panel, '当前浏览器录音无法启动: ' + err.message);
  }
}

function restartRxOnlineSource(panel, reason) {
  if (!panel || panel.key !== 'rx') return;
  if (reason) onlineLog(panel, reason);
  queueOnlineRestart(panel, reason);
}

function queueOnlineRestart(panel, reason) {
  if (!panel) return;
  if (!panel.running) {
    if (panel.root.classList.contains('open'))
      maybeAutoStartOnline(panel);
    return;
  }
  if (panel.starting) {
    panel.restartRequested = true;
    panel.restartReason = reason || '';
    onlineLog(panel, '在线启动仍在进行，等待启动返回后重启');
    return;
  }
  if (panel.restartTimer)
    clearTimeout(panel.restartTimer);
  stopOnlineStream(panel.key);
  panel.restartTimer = setTimeout(() => {
    panel.restartTimer = null;
    startOnlineStream(panel.key);
  }, 800);
}

async function loadBrowserCaptureDevices(panel, refresh) {
  if ((!refresh && panel.browserDevicesLoaded) || !panel.refs.hostDevice) return;
  if (!navigator.mediaDevices || typeof navigator.mediaDevices.enumerateDevices !== 'function') {
    panel.refs.hostDevice.disabled = true;
    return;
  }
  const current = panel.refs.hostDevice.value;
  try {
    const devices = (await navigator.mediaDevices.enumerateDevices())
      .filter(device => device.kind === 'audioinput');
    const options = ['<option value="">default</option>'];
    devices.forEach((device, index) => {
      const label = device.label || `audio input ${index + 1}`;
      options.push(`<option value="${htmlEscape(device.deviceId)}">${htmlEscape(label)}</option>`);
    });
    panel.refs.hostDevice.innerHTML = options.join('');
    panel.refs.hostDevice.value = [...panel.refs.hostDevice.options]
      .some(option => option.value === current) ? current : '';
    panel.browserDevicesLoaded = true;
  } catch (err) {
    onlineLog(panel, '读取当前浏览器录音设备失败: ' + err.message);
  }
}

// ── offline simulation ──
const offlinePanels = {};
let offlineControlsBound = false;
let pendingOfflineChannel = 'tx';

function offlineKey(ch) {
  return String(ch || currentChannel || 'tx').toLowerCase() === 'rx' ? 'rx' : 'tx';
}

function ensureOfflinePanel(ch) {
  const key = offlineKey(ch);
  if (offlinePanels[key]) return offlinePanels[key];
  const prefix = key === 'rx' ? 'offRx' : 'offTx';
  const panel = {
    key,
    input: null,
    output: null,
    inputWave: new WaveformRenderer(document.getElementById(prefix + 'InputCanvas')),
    outputWave: new WaveformRenderer(document.getElementById(prefix + 'OutputCanvas')),
    inputTabs: document.getElementById(prefix + 'InputTabs'),
    outputTabs: document.getElementById(prefix + 'OutputTabs'),
    inputInfo: document.getElementById(prefix + 'InputInfo'),
    outputInfo: document.getElementById(prefix + 'OutputInfo'),
  };
  panel.outputWave.color = '#52a6ff';
  panel.outputWave.outputPreview = true;
  panel.inputWave.onViewChange = source => syncOfflineWaveforms(panel, source);
  panel.outputWave.onViewChange = source => syncOfflineWaveforms(panel, source);
  offlinePanels[key] = panel;
  return panel;
}

function syncOfflineWaveforms(panel, source) {
  const timeline = document.getElementById('offTimeline');
  if (!panel || !timeline || timeline.value !== 'sync') return;
  const target = source === panel.inputWave ? panel.outputWave : panel.inputWave;
  if (!target) return;
  target.copyViewFrom(source);
}

function configureOfflinePanel(panel) {
  if (!panel) return;
  const display = document.getElementById('offDisplay');
  const timeline = document.getElementById('offTimeline');
  const displayMode = display ? display.value : 'time';
  panel.inputWave.displayMode = displayMode;
  panel.outputWave.displayMode = displayMode;
  renderChannelTabs(panel.inputTabs, panel.inputWave, panel.inputWave.channels, 'ch');
  renderChannelTabs(panel.outputTabs, panel.outputWave, panel.outputWave.channels, 'ch');
  if (timeline && timeline.value === 'sync')
    panel.outputWave.copyViewFrom(panel.inputWave);
  panel.inputWave.paint();
  panel.outputWave.paint();
}

function configureOfflineWaveforms() {
  Object.values(offlinePanels).forEach(configureOfflinePanel);
}

function bindOfflineControls() {
  if (offlineControlsBound) return;
  offlineControlsBound = true;
  const display = document.getElementById('offDisplay');
  const timeline = document.getElementById('offTimeline');
  if (display) display.addEventListener('change', configureOfflineWaveforms);
  if (timeline) timeline.addEventListener('change', configureOfflineWaveforms);
}

function startOffline() {
  document.getElementById('offlineDialog').classList.add('open');
  ensureOfflinePanel('tx');
  ensureOfflinePanel('rx');
  bindOfflineControls();
  configureOfflineWaveforms();
  bindWaveSplitters();
}

function bindWaveSplitters() {
  document.querySelectorAll('.wave-split-handle:not([data-bound])').forEach(handle => {
    handle.dataset.bound = '1';
    handle.addEventListener('pointerdown', e => {
      e.preventDefault();
      handle.setPointerCapture(e.pointerId);
      const grid = handle.parentElement;
      const wraps = grid.querySelectorAll('.waveform-wrap');
      if (wraps.length < 2) return;
      const above = wraps[0];
      const below = wraps[1];
      const startY = e.clientY;
      const startH1 = above.getBoundingClientRect().height;
      const startH2 = below.getBoundingClientRect().height;

      const onMove = ev => {
        const dy = ev.clientY - startY;
        const newH1 = Math.max(40, startH1 + dy);
        const newH2 = Math.max(40, startH2 - dy);
        above.style.height = newH1 + 'px';
        above.style.flex = 'none';
        below.style.height = newH2 + 'px';
        below.style.flex = 'none';
        if (above.querySelector('canvas') && above.querySelector('canvas')._renderer)
          above.querySelector('canvas')._renderer.paint();
        if (below.querySelector('canvas') && below.querySelector('canvas')._renderer)
          below.querySelector('canvas')._renderer.paint();
      };
      const onUp = () => {
        handle.removeEventListener('pointermove', onMove);
        handle.removeEventListener('pointerup', onUp);
      };
      handle.addEventListener('pointermove', onMove);
      handle.addEventListener('pointerup', onUp);
    });
  });
}

function closeOfflineDialog() {
  document.getElementById('offlineDialog').classList.remove('open');
}

function importAudioFile(ch) {
  pendingOfflineChannel = offlineKey(ch);
  document.getElementById('fileAudio').click();
}
document.getElementById('fileAudio').addEventListener('change', e => {
  const file = e.target.files[0];
  if (!file) return;
  const panel = ensureOfflinePanel(pendingOfflineChannel);
  const reader = new FileReader();
  reader.onload = async ev => {
    const buf = ev.target.result;
    const chCfg = onlineChannelConfigFor(pendingOfflineChannel);
    const expectedInCh = chCfg.inputChannels;
    let parsed = parseWavToFloat(buf);
    if (!parsed) {
      const result = await showRawImportDialog(buf, file.name, expectedInCh, 16000);
      if (!result) return;
      parsed = result;
    }
    const { samples, channels, sampleRate } = parsed;
    const numSamples = samples.length;
    // Validate channel count against device settings
    if (channels !== expectedInCh) {
      log(`通道数不匹配: 文件 ${channels}ch, 需要 ${expectedInCh}ch (${pendingOfflineChannel === 'tx' ? `Mic${chCfg.micChannels}+Ref${chCfg.refChannels}` : `Input${chCfg.inputChannels}`})`, 'offLog');
      panel.input = null;
      panel.inputWave.samples = [];
      panel.inputInfo.textContent = `Error: ${channels}ch ≠ ${expectedInCh}ch required`;
      return;
    }
    panel.input = { fileName: file.name, samples, channels, sampleRate };
    panel.output = null;
    panel.inputWave.samples = samples;
    panel.inputWave.channels = channels;
    panel.inputWave.sampleRate = sampleRate;
    panel.inputWave.channelIndex = 0;
    panel.inputWave.followTail = false;
    panel.inputWave.timeZoom = 1.0;
    panel.outputWave.samples = [];
    panel.outputWave.channelIndex = 0;
    const outCfg = onlineChannelConfigFor(pendingOfflineChannel);
    panel.outputWave.channels = pendingOfflineChannel === 'rx' ? outCfg.inputChannels : outCfg.outputChannels;
    panel.outputWave.sampleRate = sampleRate;
    configureOfflinePanel(panel);
    panel.inputInfo.textContent =
      `Source: ${file.name} | ${channels}ch | ${sampleRate}Hz | ${(numSamples/channels/sampleRate).toFixed(2)}s`;
    panel.outputInfo.textContent = 'Output: --';
    log(`导入 ${panel.key.toUpperCase()} 音频: ` + file.name, 'offLog');
  };
  reader.readAsArrayBuffer(file);
  e.target.value = '';
});

function renderOfflineOutput(panel, samples, channels, sampleRate, source) {
  panel.output = { samples, channels, sampleRate };
  panel.outputWave.samples = samples;
  panel.outputWave.channels = channels;
  panel.outputWave.sampleRate = sampleRate;
  panel.outputWave.channelIndex = 0;
  panel.outputWave.followTail = false;
  panel.outputWave.timeZoom = 1.0;
  configureOfflinePanel(panel);
  panel.outputInfo.textContent =
    `Output: ${source} | ${channels}ch | ${sampleRate}Hz | ${(samples.length/channels/sampleRate).toFixed(2)}s`;
}

async function runOfflineSim(ch) {
  const channelKey = offlineKey(ch);
  const panel = ensureOfflinePanel(channelKey);
  if (!panel.input) {
    alert('请先导入音频');
    return;
  }
  const cfg = state.config[channelKey];
  document.getElementById('offStatus').textContent = channelKey.toUpperCase() + ' 运行中';
  resetOfflinePerf(channelKey);

  // Encode input PCM as 16-bit WAV, then base64
  const wavBlob = wavBlobFromFloat(panel.input.samples, panel.input.channels, panel.input.sampleRate);
  const wavBuf = await wavBlob.arrayBuffer();
  let binary = '';
  const bytes = new Uint8Array(wavBuf);
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  const inputBase64 = btoa(binary);

  // Get refChannels from device settings for TX
  const refCh = channelKey === 'tx'
    ? (document.getElementById('mainRefChannels') ? document.getElementById('mainRefChannels').value : 1)
    : undefined;

  // SED babycry detection needs the device NPU: when a model is selected and
  // a device is connected, route the offline run through the device.
  const bridgeTarget = bridgeIsOpen() ? currentBridgeTarget() : null;
  const sedOnDevice = channelKey === 'tx'
    && (state.sedModel || state.sedAuto)
    && bridgeTarget && bridgeTarget.adbDevice;

  if (bridgeIsOpen()) {
    try {
      const result = await sendBridgeCommand('offline.run', {
        channel: channelKey.toUpperCase(),
        version: state.configVersion[channelKey],
        config: cfg,
        inputBase64: inputBase64,
        refChannels: Number(refCh) || 1,
        target: currentBridgeTarget(),
        ...(sedOnDevice ? {
          device: bridgeTarget,
          sedModel: state.sedModel
            ? { name: state.sedModel.name, base64: state.sedModel.base64 }
            : undefined,
          sedAuto: state.sedAuto === true ? true : undefined,
        } : {}),
      }, 120000);

      if (result && result.outputBase64) {
        // Decode output WAV
        const outBinary = atob(result.outputBase64);
        const outBytes = new Uint8Array(outBinary.length);
        for (let i = 0; i < outBinary.length; i++) outBytes[i] = outBinary.charCodeAt(i);
        const outBuf = outBytes.buffer;
        const view = new DataView(outBuf);
        // Parse WAV
        let channels = 1, sampleRate = panel.input.sampleRate, dataOffset = 44, dataLen = outBuf.byteLength - 44;
        if (view.byteLength >= 44 && view.getUint32(0, false) === 0x52494646) {
          channels = view.getUint16(22, true);
          sampleRate = view.getUint32(24, true);
          let offset = 12;
          while (offset < view.byteLength - 8) {
            const id = view.getUint32(offset, false);
            const sz = view.getUint32(offset + 4, true);
            if (id === 0x64617461) { dataOffset = offset + 8; dataLen = sz; break; }
            offset += 8 + sz;
          }
        }
        const numSamples = Math.floor(dataLen / 2);
        const samples = new Array(numSamples);
        for (let i = 0; i < numSamples; i++) {
          samples[i] = view.getInt16(dataOffset + i * 2, true) / 32768.0;
        }
        renderOfflineOutput(panel, samples, channels, sampleRate, 'VQE');
      }
      if (result && result.log) log(result.log, 'offLog');
      log(channelKey.toUpperCase() + ' 离线仿真已通过 Bridge 完成', 'offLog');
      showOfflinePerf(channelKey, result.perf);
      showOfflineSedStatus(channelKey, result.sed, result.source);
      const offSpans = Array.isArray(result.sedSpans) ? result.sedSpans : [];
      panel.outputWave.eventSpans = offSpans;
      panel.inputWave.eventSpans = offSpans;
      panel.outputWave.paint();
      panel.inputWave.paint();
      if (!result || !result.perf)
        document.getElementById('offStatus').textContent = channelKey.toUpperCase() + ' 完成';
      return;
    } catch (err) {
      log('Bridge 离线仿真失败: ' + err.message, 'offLog');
      showOfflineSedStatus(channelKey, null);
      panel.outputWave.eventSpans = [];
      panel.inputWave.eventSpans = [];
      panel.outputWave.paint();
      panel.inputWave.paint();
    }
  }
  const chCfgDemo = onlineChannelConfigFor(channelKey);
  const demoOutCh = channelKey === 'rx' ? chCfgDemo.inputChannels : chCfgDemo.outputChannels;
  const demoOutput = panel.input.samples.map(v => clamp(v * 0.85, -1, 1));
  renderOfflineOutput(panel, demoOutput, demoOutCh, panel.input.sampleRate, 'demo');
  document.getElementById('offStatus').textContent = channelKey.toUpperCase() + ' 演示完成';
  showOfflineSedStatus(channelKey, null);
  panel.outputWave.eventSpans = [];
  panel.inputWave.eventSpans = [];
  panel.outputWave.paint();
  panel.inputWave.paint();
  log(channelKey.toUpperCase() + ' 本地 Bridge 未连接，离线仿真使用浏览器演示输出', 'offLog');
}

function showOfflineSedStatus(ch, sed, source) {
  const el = document.getElementById('offSedStatus');
  if (!el) return;
  const isTx = offlineKey(ch) === 'tx';
  if (!isTx || !sed) {
    el.style.display = isTx ? '' : 'none';
    el.textContent = t('sed_offline_inactive');
    el.style.color = 'var(--muted)';
    el.style.background = 'transparent';
    return;
  }
  el.style.display = '';
  el.textContent = sed.bcd > 0
    ? t('sed_babycry_detected') + ' x' + sed.bcd
    : t('sed_babycry_none');
  el.style.color = sed.bcd > 0 ? '#ff5f56' : '#52c58e';
  el.style.background = sed.bcd > 0 ? 'rgba(255,95,86,.12)' : 'rgba(82,197,142,.10)';
}

function exportSimResult(ch) {
  const channelKey = offlineKey(ch);
  const panel = ensureOfflinePanel(channelKey);
  if (!panel.output || !panel.output.samples.length) {
    alert('当前没有可导出的离线仿真结果');
    return;
  }
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  downloadBlob(`offline_${channelKey}_${stamp}_output.wav`,
    wavBlobFromFloat(panel.output.samples, panel.output.channels, panel.output.sampleRate));
  log('已导出 ' + channelKey.toUpperCase() + ' 离线仿真结果 WAV', 'offLog');
}

// ── demo waveform animation on main page ──
const miniCanvas = document.getElementById('miniWaveform');
let miniCtx = null;
let miniPhase = 0;
function animateMini() {
  if (!miniCanvas || !miniCtx) return;
  const rect = miniCanvas.parentElement.getBoundingClientRect();
  const dpr = window.devicePixelRatio || 1;
  if (miniCanvas.width !== rect.width * dpr) {
    miniCanvas.width = rect.width * dpr;
    miniCanvas.height = rect.height * dpr;
    miniCtx.setTransform(dpr,0,0,dpr,0,0);
  }
  const w = rect.width, h = rect.height;
  miniCtx.fillStyle = '#181f26';
  miniCtx.fillRect(0,0,w,h);
  // grid
  miniCtx.strokeStyle = '#39444f';
  miniCtx.lineWidth = 0.5;
  for (let i=1;i<4;i++) { miniCtx.beginPath(); miniCtx.moveTo(0,h*i/4); miniCtx.lineTo(w,h*i/4); miniCtx.stroke(); }
  for (let i=1;i<10;i++) { miniCtx.beginPath(); miniCtx.moveTo(w*i/10,0); miniCtx.lineTo(w*i/10,h); miniCtx.stroke(); }
  // wave
  miniCtx.strokeStyle = '#36c57e';
  miniCtx.lineWidth = 1.5;
  miniCtx.beginPath();
  for (let x=0; x<w; x++) {
    const t = (x + miniPhase) * 0.04;
    const y = h/2 + Math.sin(t)*h*0.25 + Math.sin(t*2.7)*h*0.08 + Math.sin(t*0.3)*h*0.12;
    x===0 ? miniCtx.moveTo(x,y) : miniCtx.lineTo(x,y);
  }
  miniCtx.stroke();
  miniPhase += 2;
  requestAnimationFrame(animateMini);
}
if (miniCanvas) { miniCtx = miniCanvas.getContext('2d'); animateMini(); }

// ── render timer for online waveforms ──
setInterval(() => {
  Object.values(onlinePanels).forEach(panel => {
    panel.inputWave.paint();
    panel.outputWave.paint();
  });
}, 100);

// ── keyboard shortcuts ──
document.addEventListener('keydown', e => {
  if (e.key === 'Escape') {
    Object.values(onlinePanels).forEach(panel => {
      if (panel.root.classList.contains('open')) closeOnlineDialog(panel.key);
    });
    closeOfflineDialog();
  }
});
window.addEventListener('beforeunload', notifyBridgePageClosing);

notifyBridgePageAlive();
applyLanguage();
refreshDeviceSettingsUi();
bindLogSplitters();
renderParams();
renderMigrationMatrix();
refreshConfigHistory();
refreshBridgeStatus();
log('RockAA Dashboard (HTML5) 已启动');
log('提示: 连接后可使用在线仿真、参数下发等功能');
