function setBadge(el, kind, text) {
  if (!el) return;
  el.className = 'badge ' + kind;
  el.textContent = text;
}

function bridgeStatusText(text) {
  const map = {
    '已连接': 'bridge_connected',
    '未连接': 'bridge_disconnected',
    '检测中': 'bridge_detecting',
    '版本过旧': 'bridge_outdated',
    'WebSocket 不可用': 'bridge_unavailable',
    Connected: 'bridge_connected',
    Disconnected: 'bridge_disconnected',
    Detecting: 'bridge_detecting',
    Outdated: 'bridge_outdated',
  };
  return t(map[text] || text);
}

function setBridgeUi(kind, text, endpoint) {
  const status = bridgeStatusText(text);
  setBadge(document.getElementById('bridgeBadge'), kind, t('bridge_label') + ': ' + status);
  setBadge(document.getElementById('bridgeState'), kind, status);
  const ep = document.getElementById('bridgeEndpoint');
  if (ep) ep.textContent = endpoint || state.bridge.url || BRIDGE_URLS[0];
}

function bridgeIsOpen() {
  return !!state.bridge.ws && state.bridge.ws.readyState === WebSocket.OPEN;
}

function normalizeCapabilities(caps) {
  if (Array.isArray(caps)) {
    return caps.reduce((obj, key) => {
      obj[key] = true;
      return obj;
    }, {});
  }
  return caps && typeof caps === 'object' ? caps : {};
}

function parseBridgeVersion(version) {
  return String(version || '').split('.').map(part => {
    const n = Number(part.replace(/[^0-9].*$/, ''));
    return Number.isFinite(n) ? n : 0;
  });
}

function bridgeVersionAtLeast(version, minimum) {
  const current = parseBridgeVersion(version);
  const required = parseBridgeVersion(minimum);
  for (let i = 0; i < Math.max(current.length, required.length); i++) {
    const c = current[i] || 0;
    const r = required[i] || 0;
    if (c > r) return true;
    if (c < r) return false;
  }
  return true;
}

function staleBridgeMessage(version) {
  return `本地 Native Bridge 版本过旧: ${version || 'unknown'}，需要 ${MIN_BRIDGE_VERSION}。`
    + ' 请在 dashboard/html 重新执行 npm stop && npm start。';
}

function applyBridgeInfo(info) {
  const bridgeInfo = info || {};
  state.bridge.version = bridgeInfo.version || '';
  state.bridge.capabilities = normalizeCapabilities(bridgeInfo.capabilities);
  const endpoint = state.bridge.version ? `${state.bridge.url} | ${state.bridge.version}` : state.bridge.url;
  const epEl = document.getElementById('bridgeEndpoint');
  if (epEl) epEl.textContent = endpoint;
  renderMigrationMatrix();
  if (!bridgeVersionAtLeast(state.bridge.version, MIN_BRIDGE_VERSION))
    throw new Error(staleBridgeMessage(state.bridge.version));
  return bridgeInfo;
}

async function ensureBridgeReady() {
  const ok = await connectBridge();
  if (!ok) throw new Error('Native Bridge 未连接');
  const info = await sendBridgeCommand('bridge.info', {}, 3000);
  try {
    return applyBridgeInfo(info);
  } catch (err) {
    setBridgeUi('err', '版本过旧', state.bridge.url);
    log(err.message);
    if (state.bridge.ws) {
      try { state.bridge.ws.close(); } catch (_) {}
    }
    state.bridge.ws = null;
    state.bridge.connected = false;
    throw err;
  }
}

function hasBridgeCapability(name) {
  const caps = state.bridge.capabilities || {};
  return caps[name] === true || caps[name] === 'ok' || caps[name] === 'ready';
}

function renderMigrationMatrix() {
  const matrix = document.getElementById('migrationMatrix');
  if (!matrix) return;
  matrix.innerHTML = MIGRATION_FEATURES.map(item => {
    const nativeReady = item.status === 'bridge' && state.bridge.connected
      && (!item.cap || hasBridgeCapability(item.cap));
    const kind = item.status === 'html' ? 'ok' : nativeReady ? 'ok' : 'warn';
    const label = item.status === 'html'
      ? t('html_migrated')
      : nativeReady ? t('bridge_declared') : t('bridge_required');
    const name = lang === 'en' && item.nameEn ? item.nameEn : item.name;
    const note = lang === 'en' && item.noteEn ? item.noteEn : item.note;
    return `<div class="migration-item">
      <div class="migration-title">
        <span>${htmlEscape(name)}</span>
        <span class="badge ${kind}">${label}</span>
      </div>
      <div class="migration-note">${htmlEscape(note)}</div>
    </div>`;
  }).join('');
}

function currentBridgeTarget() {
  return {
    mode: state.mode,
    adbDevice: document.getElementById('adbDevice').value || '',
    host: document.getElementById('netHost').value || '',
    port: document.getElementById('netPort').value || '',
  };
}

function populateAdbDevices(devices) {
  const select = document.getElementById('adbDevice');
  const previous = select.value;
  const list = Array.isArray(devices) ? devices.filter(Boolean) : [];
  const stillThere = !!previous && list.some(device =>
    (typeof device === 'string' ? device : device.id || device.serial) === previous);
  // Auto-disconnect if the device we're actually connected to just vanished.
  // Check state.adbDevice (the connected serial) rather than select.value,
  // which may have been switched by the user without a reconnect.
  if (state.connected && state.adbDevice
      && !list.some(device => (typeof device === 'string' ? device : device.id || device.serial) === state.adbDevice)
      && typeof setConnectionState === 'function') {
    setConnectionState(false);
    log(`设备 ${state.adbDevice} 已离线，断开连接`);
  }
  select.innerHTML = '';
  if (!list.length) {
    const option = document.createElement('option');
    option.value = '';
    option.textContent = state.bridge.connected ? t('no_adb_device') : t('need_local_bridge');
    select.appendChild(option);
    return;
  }
  for (const device of list) {
    const option = document.createElement('option');
    const id = typeof device === 'string' ? device : (device.id || device.serial || device.name || '');
    option.value = id;
    option.textContent = typeof device === 'string'
      ? device
      : `${id}${device.state ? ' (' + device.state + ')' : ''}`;
    select.appendChild(option);
  }
  if (stillThere) select.value = previous;
}

function rejectBridgePending(err) {
  for (const pending of state.bridge.pending.values()) {
    clearTimeout(pending.timer);
    pending.reject(err);
  }
  state.bridge.pending.clear();
}

// The command socket and a panel's stream socket both receive the
// session log and perf broadcasts, which would render every message
// twice in the panel. Once the panel's stream socket is attached, that
// path owns the channel and the command socket drops its copies. The
// panels live in the global onlinePanels table (simulation.js).
function onlineStreamOwnsChannel(channel) {
  if (typeof onlinePanels === 'undefined') return false;
  const panel = onlinePanels[String(channel || '').toLowerCase()];
  return !!(panel && panel.ws && panel.ws.readyState === 1);
}

function setupBridgeSocket(ws, url) {
  ws.onmessage = ev => {
    if (typeof ev.data !== 'string') return;
    let msg = null;
    try {
      msg = JSON.parse(ev.data);
    } catch (err) {
      log('Bridge 消息解析失败: ' + err.message);
      return;
    }
    if (msg.id && state.bridge.pending.has(msg.id)) {
      const pending = state.bridge.pending.get(msg.id);
      clearTimeout(pending.timer);
      state.bridge.pending.delete(msg.id);
      if (msg.ok === false || msg.error) pending.reject(new Error(msg.error || 'Bridge command failed'));
      else pending.resolve(Object.prototype.hasOwnProperty.call(msg, 'result') ? msg.result : msg);
      return;
    }
    if (msg.type === 'online.log' && msg.message) {
      if (onlineStreamOwnsChannel(msg.channel)) return;
      if (typeof handleOnlineBridgeLog === 'function')
        handleOnlineBridgeLog(msg.channel, msg.message);
      else
        log('[Bridge][' + (msg.channel || '') + '] ' + msg.message);
      return;
    }
    if (msg.type === 'online.perf') {
      if (onlineStreamOwnsChannel(msg.channel)) return;
      if (typeof handleOnlineBridgePerf === 'function')
        handleOnlineBridgePerf(msg.channel, msg.perf || {});
      return;
    }
    if (msg.type === 'pae.log' && msg.message) {
      if (typeof handlePaeLog === 'function')
        handlePaeLog(msg.message);
      else
        log('[PAE] ' + msg.message);
      return;
    }
    if (msg.type === 'codec.log' && msg.message) {
      if (typeof handleCodecLog === 'function')
        handleCodecLog(msg.message);
      else
        log('[Codec] ' + msg.message);
      return;
    }
    if (msg.type && typeof msg.type === 'string' && msg.type.startsWith('autotune.')) {
      if (typeof handleAutotuneMessage === 'function') handleAutotuneMessage(msg);
      return;
    }
    if (msg.type === 'adb.devices-changed') {
      populateAdbDevices(Array.isArray(msg.devices) ? msg.devices : []);
      return;
    }
    if (msg.type === 'log' && msg.message) log('[Bridge] ' + msg.message);
  };
  ws.onclose = () => {
    if (state.bridge.ws === ws) {
      state.bridge.ws = null;
      state.bridge.connected = false;
      state.bridge.capabilities = {};
      rejectBridgePending(new Error('Bridge disconnected'));
      setBridgeUi('warn', '未连接', url);
      renderMigrationMatrix();
      scheduleBridgeReconnect(1500);
    }
  };
}

function openBridgeSocket(url) {
  return new Promise(resolve => {
    let settled = false;
    const ws = new WebSocket(url);
    const finish = ok => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(ok);
    };
    const timer = setTimeout(() => {
      try { ws.close(); } catch (_) {}
      finish(false);
    }, 900);
    ws.onopen = () => {
      if (settled) {
        try { ws.close(); } catch (_) {}
        return;
      }
      state.bridge.ws = ws;
      state.bridge.connected = true;
      state.bridge.url = url;
      setupBridgeSocket(ws, url);
      setBridgeUi('ok', '已连接', url);
      log('Native Bridge 已连接: ' + url);
      if (typeof refreshConfigHistory === 'function') refreshConfigHistory();
      finish(true);
    };
    ws.onerror = () => finish(false);
    ws.onclose = () => {
      if (!settled) finish(false);
    };
  });
}

let bridgeReconnectTimer = null;

function scheduleBridgeReconnect(delayMs) {
  if (bridgeReconnectTimer || bridgeIsOpen()) return;
  bridgeReconnectTimer = setTimeout(async () => {
    bridgeReconnectTimer = null;
    if (bridgeIsOpen()) return;
    if (await connectBridge()) {
      try { await refreshBridgeStatus(); } catch (_) {}
    } else {
      scheduleBridgeReconnect(1500);
    }
  }, delayMs || 1500);
}

async function connectBridge() {
  if (bridgeIsOpen()) return true;
  if (!window.WebSocket) {
    setBridgeUi('err', 'WebSocket 不可用');
    return false;
  }
  for (const url of BRIDGE_URLS) {
    setBridgeUi('warn', '检测中', url);
    if (await openBridgeSocket(url)) return true;
  }
  state.bridge.connected = false;
  state.bridge.capabilities = {};
  setBridgeUi('warn', '未连接', BRIDGE_URLS[0]);
  populateAdbDevices([]);
  renderMigrationMatrix();
  scheduleBridgeReconnect(1500);
  return false;
}

function sendBridgeCommand(cmd, payload, timeoutMs) {
  if (!bridgeIsOpen()) return Promise.reject(new Error('Native Bridge 未连接'));
  const id = ++state.bridge.seq;
  const body = Object.assign({ id, cmd }, payload || {});
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      state.bridge.pending.delete(id);
      reject(new Error(cmd + ' timeout'));
    }, timeoutMs || BRIDGE_TIMEOUT_MS);
    state.bridge.pending.set(id, { resolve, reject, timer });
    state.bridge.ws.send(JSON.stringify(body));
  });
}

function notifyBridgePageAlive() {
  if (location.protocol !== 'http:' && location.protocol !== 'https:') return;
  fetch('/__bridge/alive', {
    method: 'POST',
    cache: 'no-store',
    keepalive: true,
  }).catch(() => {});
}

function notifyBridgePageClosing() {
  if (location.protocol !== 'http:' && location.protocol !== 'https:') return;
  if (navigator.sendBeacon) {
    navigator.sendBeacon('/__bridge/shutdown', new Blob([], { type: 'text/plain' }));
    return;
  }
  fetch('/__bridge/shutdown', {
    method: 'POST',
    cache: 'no-store',
    keepalive: true,
  }).catch(() => {});
}

async function refreshBridgeStatus() {
  try {
    await ensureBridgeReady();
  } catch (err) {
    log('未检测到本地 Native Bridge，HTML 保持浏览器演示模式');
    if (err && err.message) log(err.message);
    populateAdbDevices([]);
    return;
  }
  try {
    const result = await sendBridgeCommand('adb.devices') || {};
    populateAdbDevices(Array.isArray(result) ? result : result.devices);
  } catch (err) {
    log('读取 ADB 设备失败: ' + err.message);
    populateAdbDevices([]);
  }
}
