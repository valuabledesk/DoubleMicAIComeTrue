// ── transport mode ──
document.querySelectorAll('#transportMode .seg').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('#transportMode .seg').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    state.mode = btn.dataset.mode;
    document.getElementById('connectFields').style.display = state.mode === 'adb' ? 'contents' : 'none';
    document.getElementById('netFields').style.display = state.mode === 'net' ? 'contents' : 'none';
  });
});

// ── sidebar nav ──
document.querySelectorAll('.nav-item[data-page]').forEach(item => {
  item.addEventListener('click', () => {
    document.querySelectorAll('.nav-item').forEach(n => n.classList.remove('active'));
    item.classList.add('active');
    const page = item.dataset.page;
    if (page === 'pae') {
      if (typeof closeAutotuneDialog === 'function') closeAutotuneDialog();
      if (typeof closeEffectTuningPage === 'function') closeEffectTuningPage();
      if (typeof openPaeDialog === 'function') openPaeDialog();
      return;
    }
    if (typeof closePaeDialog === 'function') closePaeDialog();
    if (page === 'autotune') {
      if (typeof closeEffectTuningPage === 'function') closeEffectTuningPage();
      // openAutotuneDialog is defined in autotune.js (loaded later) — forward ref OK
      // since the handler only fires on user click.
      if (typeof openAutotuneDialog === 'function') openAutotuneDialog();
      return;
    }
    if (page === 'effect-tuning') {
      if (typeof closeAutotuneDialog === 'function') closeAutotuneDialog();
      if (typeof openEffectTuningPage === 'function') openEffectTuningPage();
      return;
    }
    if (page === 'codec') {
      if (typeof closeAutotuneDialog === 'function') closeAutotuneDialog();
      if (typeof closeEffectTuningPage === 'function') closeEffectTuningPage();
      if (typeof openCodecDialog === 'function') openCodecDialog();
      return;
    }
    // Switching to any other page — leave autotune view if it's open.
    if (typeof closeAutotuneDialog === 'function') closeAutotuneDialog();
    if (typeof closeEffectTuningPage === 'function') closeEffectTuningPage();
  });
});

// ── param tabs ──
let currentChannel = 'tx';
function paramGridId() {
  return state.paramWindowOpen ? 'paramWindowGrid' : 'paramGrid';
}
function switchTab(el, ch) {
  document.querySelectorAll('.tabs .tab').forEach(t => t.classList.remove('active'));
  el.classList.add('active');
  // Sync param window tabs if open
  if (state.paramWindowOpen) {
    document.querySelectorAll('#paramWindowTabs .tab').forEach(t => t.classList.remove('active'));
    const twin = document.querySelector(`#paramWindowTabs .tab[data-tab="${ch}"]`);
    if (twin) twin.classList.add('active');
  }
  currentChannel = ch;
  renderParams();
  if (typeof refreshDeviceSettingsUi === 'function') refreshDeviceSettingsUi();
}
function switchParamWindowTab(el, ch) {
  // Sync main page tabs
  document.querySelectorAll('#paramWindowTabs .tab').forEach(t => t.classList.remove('active'));
  el.classList.add('active');
  document.querySelectorAll('#pageTuning .tabs .tab').forEach(t => t.classList.remove('active'));
  const twin = document.querySelector(`#pageTuning .tabs .tab[data-tab="${ch}"]`);
  if (twin) twin.classList.add('active');
  currentChannel = ch;
  renderParams();
  if (typeof refreshDeviceSettingsUi === 'function') refreshDeviceSettingsUi();
}

// ── config import/export ──
const CONFIG_HISTORY_KEY = 'rockaa_dashboard_html_config_history_v1';
let bridgeConfigFiles = [];

function importConfig() {
  refreshConfigHistory();
  document.getElementById('fileConfig').click();
}

async function importConfigFromDevice() {
  const target = currentBridgeTarget();
  const deviceId = target.adbDevice || '';
  if (target.mode !== 'adb' || !deviceId || deviceId === 'no-adb-device') {
    alert(t('need_adb_device'));
    return;
  }

  try {
    await ensureBridgeReady();
  } catch (err) {
    alert(t('need_local_bridge'));
    log('设备导入失败: Bridge 未连接');
    return;
  }

  let paths = [];
  try {
    const result = await sendBridgeCommand('device.config.list', { target }, 8000);
    paths = result && Array.isArray(result.paths) ? result.paths : [];
  } catch (err) {
    alert(t('device_import_failed') + ': ' + err.message);
    log('设备配置列表失败: ' + err.message);
    return;
  }

  if (!paths.length) {
    alert(t('no_device_config'));
    return;
  }

  let selectedPath = paths[0];
  if (paths.length > 1) {
    selectedPath = await new Promise(resolve => {
      const overlay = document.createElement('div');
      overlay.className = 'dialog-overlay';
      overlay.style.cssText = 'z-index:9999;display:flex;align-items:center;justify-content:center';
      overlay.innerHTML = `<div class="dialog" style="width:480px">
        <div class="dialog-header"><h2>${htmlEscape(t('select_device_config'))}</h2></div>
        <div class="dialog-body" style="padding:12px 20px">
          <select id="_deviceConfigSelect" class="field" style="width:100%">${paths.map((p, i) =>
            `<option value="${i}">${htmlEscape(p)}</option>`).join('')}</select>
        </div>
        <div style="padding:0 20px 16px;display:flex;gap:8px;justify-content:flex-end">
          <button class="btn" id="_deviceConfigCancel">${htmlEscape(t('close'))}</button>
          <button class="btn primary" id="_deviceConfigOk">${htmlEscape(t('import_config'))}</button>
        </div>
      </div>`;
      document.body.appendChild(overlay);

      const cleanup = value => {
        document.body.removeChild(overlay);
        resolve(value);
      };
      overlay.querySelector('#_deviceConfigCancel').addEventListener('click', () => cleanup(null));
      overlay.querySelector('#_deviceConfigOk').addEventListener('click', () => {
        const idx = Number(overlay.querySelector('#_deviceConfigSelect').value);
        cleanup(paths[idx] || null);
      });
      overlay.addEventListener('click', e => {
        if (e.target === overlay) cleanup(null);
      });
    });
    if (!selectedPath) return;
  }

  try {
    const result = await sendBridgeCommand('device.config.pull', {
      target,
      path: selectedPath,
    }, 15000);
    await importConfigText(result.text, result.name || selectedPath.split('/').pop(), { remember: true });
    log(t('device_import_ok') + ' ' + selectedPath);

    // Also detect audio info (sample rate, channels) from device hardware
    try {
      const audioInfo = await sendBridgeCommand('device.audio.info', { target }, 5000);
      if (audioInfo && audioInfo.sampleRate > 0) {
        ['tx', 'rx'].forEach(ch => {
          const s = state.deviceSettings[ch];
          s.sampleRate = audioInfo.sampleRate;
          if (ch === 'tx') {
            if (audioInfo.micChannels > 0) s.micChannels = audioInfo.micChannels;
            if (audioInfo.refChannels > 0 || audioInfo.refChannels === 0) s.refChannels = audioInfo.refChannels;
            s.inputChannels = s.micChannels + s.refChannels;
          }
        });
        document.getElementById('metRate').textContent = (audioInfo.sampleRate / 1000) + 'k';
        refreshDeviceSettingsUi();
      }
    } catch (err) {
      log('设备音频信息检测失败: ' + (err && err.message ? err.message : err));
    }
  } catch (err) {
    alert(t('device_import_failed') + ': ' + err.message);
    log('设备配置拉取失败: ' + err.message);
  }
}

function rootKeyForChannel(ch) {
  return ch === 'rx' ? 'skv_ao_configs' : 'skv_configs';
}

function detectConfigChannel(json) {
  if (json && typeof json.skv_ao_configs === 'object' && !Array.isArray(json.skv_ao_configs)) return 'rx';
  if (json && typeof json.skv_configs === 'object' && !Array.isArray(json.skv_configs)) return 'tx';
  return '';
}

function detectConfigVersion(ch, root) {
  if (ch === 'rx') return root && root.rx ? 'v2' : 'v1';
  const v2Markers = ['drop_ref_chan', 'array_reset', 'aibf', 'aiec', 'smpvp', 'unkws', 'fastaec'];
  return v2Markers.some(k => Object.prototype.hasOwnProperty.call(root || {}, k)) ? 'v2' : 'v1';
}

function setActiveTab(ch) {
  const tab = document.querySelector(`.tabs .tab[data-tab="${ch}"]`);
  if (tab) switchTab(tab, ch);
}

function configHistoryItems() {
  try {
    const items = JSON.parse(localStorage.getItem(CONFIG_HISTORY_KEY) || '[]');
    return Array.isArray(items) ? items.filter(item => item && item.name && item.text) : [];
  } catch (_) {
    return [];
  }
}

function saveConfigHistory(items) {
  let next = items.slice(0, 12);
  while (next.length) {
    try {
      localStorage.setItem(CONFIG_HISTORY_KEY, JSON.stringify(next));
      return;
    } catch (_) {
      next = next.slice(0, -1);
    }
  }
}

function configHistoryId(name, text) {
  let hash = 0;
  const source = String(text || '');
  for (let i = 0; i < source.length; i++)
    hash = ((hash << 5) - hash + source.charCodeAt(i)) | 0;
  return `${name}:${source.length}:${hash >>> 0}`;
}

function rememberConfig(name, text) {
  const id = configHistoryId(name, text);
  const items = configHistoryItems().filter(item => (item.id || configHistoryId(item.name, item.text)) !== id);
  items.unshift({ id, name, text, ts: Date.now() });
  saveConfigHistory(items);
  refreshConfigHistory();
}

async function refreshConfigHistory() {
  const select = document.getElementById('configHistory');
  if (!select) return;
  const previous = select.value;
  if (select.options.length && !select.options[0].value)
    select.options[0].textContent = t('config_history');
  const recent = configHistoryItems();
  if (typeof bridgeIsOpen === 'function' && bridgeIsOpen()) {
    try {
      const listed = await sendBridgeCommand('config.list', {}, 3000);
      bridgeConfigFiles = listed && Array.isArray(listed.files) ? listed.files : [];
    } catch (err) {
      bridgeConfigFiles = [];
      log('读取 HTML 目录配置列表失败: ' + err.message);
    }
  }
  let html = `<option value="">${htmlEscape(t('config_history'))}</option>`;
  if (recent.length) {
    html += `<optgroup label="${htmlEscape(t('recent_configs'))}">`;
    html += recent.map((item, index) =>
      `<option value="recent:${index}">${htmlEscape(item.name)}</option>`).join('');
    html += '</optgroup>';
  }
  if (bridgeConfigFiles.length) {
    html += `<optgroup label="${htmlEscape(t('html_dir_configs'))}">`;
    html += bridgeConfigFiles.map((item, index) =>
      `<option value="bridge:${index}">${htmlEscape(item.path || item.name)}</option>`).join('');
    html += '</optgroup>';
  }
  select.innerHTML = html;
  select.value = previous && [...select.options].some(option => option.value === previous) ? previous : '';
}

async function validateImportedConfigVersion(ch, version) {
  if (version === 'v_hci' || typeof bridgeIsOpen !== 'function' || !bridgeIsOpen())
    return;
  const target = currentBridgeTarget();
  if (target.mode === 'adb' && !target.adbDevice) {
    log('未选择 ADB 设备，跳过板端 VQE 库版本检查');
    return;
  }
  const result = await sendBridgeCommand('vqe.version.check', {
    channel: ch.toUpperCase(),
    version,
    target,
  }, 12000);
  if (!result || result.ok !== true) {
    const boardVersion = result && result.libraryVersion ? result.libraryVersion.toUpperCase() : 'UNKNOWN';
    const runtimeDir = result && result.runtimeDir ? result.runtimeDir : 'not found';
    throw new Error(`配置版本 ${version.toUpperCase()} 与板端 VQE 库版本 ${boardVersion} 不匹配 (${runtimeDir})`);
  }
  const versionInfo = [result.gitVersion, result.changeId].filter(Boolean).join(' | ');
  const gitInfo = versionInfo ? ` | ${versionInfo}` : '';
  log(`板端 VQE 库版本检查通过: config ${version.toUpperCase()} / lib ${result.libraryVersion.toUpperCase()}${gitInfo}`);
}

async function importConfigText(text, fileName, options) {
  const json = JSON.parse(text);
  const ch = detectConfigChannel(json);
  if (!ch) throw new Error('导入的 conf 文件格式非法: 缺少 skv_configs/skv_ao_configs');
  const rootKey = rootKeyForChannel(ch);
  const version = detectConfigVersion(ch, json[rootKey]);
  state.config[ch] = json;
  state.configVersion[ch] = version;
  state.configFileName[ch] = fileName;
  state.collapsedModules[ch] = {};
  state.importedConfig[ch] = JSON.parse(JSON.stringify(json));
  if (typeof syncDeviceSettingsFromConfig === 'function') syncDeviceSettingsFromConfig(ch);
  setActiveTab(ch);
  renderParams();
  if (!options || options.remember !== false) rememberConfig(fileName, text);
  log(`导入 ${ch.toUpperCase()} ${version.toUpperCase()} 配置: ${fileName}`);
}

async function importConfigHistory(value) {
  const select = document.getElementById('configHistory');
  if (!value) return;
  try {
    if (value.startsWith('recent:')) {
      const item = configHistoryItems()[Number(value.slice(7))];
      if (!item) throw new Error('history entry not found');
      await importConfigText(item.text, item.name, { remember: true });
    } else if (value.startsWith('bridge:')) {
      const item = bridgeConfigFiles[Number(value.slice(7))];
      if (!item) throw new Error('bridge config entry not found');
      const result = await sendBridgeCommand('config.read', { path: item.path }, 5000);
      await importConfigText(result.text, result.name || item.name || item.path, { remember: true });
    }
  } catch (err) {
    alert('导入失败: ' + err.message);
    log('配置解析失败: ' + err.message);
  } finally {
    if (select) select.value = '';
  }
}

document.getElementById('fileConfig').addEventListener('change', e => {
  const file = e.target.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = async ev => {
    try {
      await importConfigText(ev.target.result, file.name, { remember: true });
    } catch (err) {
      alert('导入失败: ' + err.message);
      log('配置解析失败: ' + err.message);
    }
  };
  reader.readAsText(file);
  e.target.value = '';
});

function restoreImportedConfig(ch) {
  const backup = state.importedConfig[ch];
  if (!backup) return false;
  const rootKey = rootKeyForChannel(ch);
  const version = detectConfigVersion(ch, backup[rootKey]);
  state.config[ch] = JSON.parse(JSON.stringify(backup));
  state.configVersion[ch] = version;
  state.collapsedModules[ch] = {};
  if (typeof syncDeviceSettingsFromConfig === 'function') syncDeviceSettingsFromConfig(ch);
  renderParams();
  return true;
}

function exportConfig() {
  const cfg = state.config[currentChannel];
  if (!cfg) {
    alert('请先导入当前通道配置');
    return;
  }
  const blob = new Blob([JSON.stringify(cfg, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = currentChannel === 'rx' ? 'config_aovqe.json' : 'config_aivqe.json';
  a.click();
  URL.revokeObjectURL(a.href);
}

// ── param rendering ──
function htmlEscape(text) {
  return String(text).replace(/[&<>"']/g, ch => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[ch]));
}

function jsString(text) {
  return String(text).replace(/\\/g, '\\\\').replace(/'/g, "\\'");
}

function pathAttr(path) {
  return htmlEscape(JSON.stringify(path));
}

function displayName(path) {
  return path[path.length - 1] || '';
}

function valueToText(value) {
  if (Array.isArray(value)) return value.map(valueToText).join(' ');
  if (value && typeof value === 'object') return JSON.stringify(value);
  return value == null ? '' : String(value).replace(/^float:/, '');
}

function textToValue(text, oldValue) {
  if (Array.isArray(oldValue)) {
    const parts = text.trim().split(/\s+/).filter(Boolean);
    return parts.map((part, idx) => textToValue(part, oldValue[idx] ?? 0));
  }
  if (typeof oldValue === 'number') {
    const n = Number(text);
    return Number.isFinite(n) ? n : oldValue;
  }
  if (typeof oldValue === 'string' && oldValue.startsWith('float:')) {
    return 'float:' + text.trim();
  }
  return text;
}

function getValueByPath(root, path) {
  return path.reduce((obj, key) => obj && obj[key], root);
}

function setValueByPath(root, path, value) {
  let obj = root;
  for (let i = 0; i < path.length - 1; i++) obj = obj[path[i]];
  obj[path[path.length - 1]] = value;
}

function parameterEntries(moduleName, moduleValue) {
  const entries = [];
  const walk = (prefix, value) => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      entries.push({ path: prefix, value });
      return;
    }
    for (const [key, child] of Object.entries(value)) {
      if (key.startsWith('//')) continue;
      walk(prefix.concat(key), child);
    }
  };
  if (moduleValue && typeof moduleValue === 'object' && !Array.isArray(moduleValue)) {
    if (Object.prototype.hasOwnProperty.call(moduleValue, 'status'))
      entries.push({ path: [moduleName, 'status'], value: moduleValue.status });
    for (const [key, value] of Object.entries(moduleValue)) {
      if (key === 'status' || key.startsWith('//')) continue;
      walk([moduleName, key], value);
    }
  } else {
    entries.push({ path: [moduleName], value: moduleValue });
  }
  return entries;
}

function orderedModules(root, ch, version) {
  const txV1 = ['aec','delay','bf','fast_aec','aes','gsc','agc','anr','nlp','dereverb','cng','dtd','howl','doa','wind','filter'];
  const txV2 = ['Global','global','aec','array_reset','delay','bf','aibf','dereverb','fast_aec','aiec','aes','gsc','anr','ainr','agc','nlp','cng','dtd','howl','doa','smpvp','unkws','wind','filter'];
  const rxV1 = ['rx','anr','agc','howl','EQDRC','eqdrc'];
  const rxV2 = ['rx','anr','agc','filter','howl','EQDRC','eqdrc'];
  const preferred = ch === 'rx' ? (version === 'v2' ? rxV2 : rxV1) : (version === 'v2' ? txV2 : txV1);
  const keys = Object.keys(root).filter(k => !k.startsWith('//'));
  const ordered = preferred.filter(k => keys.includes(k));
  for (const key of keys) if (!ordered.includes(key)) ordered.push(key);
  return ordered;
}

function isModuleCollapsed(ch, moduleName) {
  const override = state.collapsedModules[ch][moduleName];
  return override === undefined ? state.paramCollapsedDefault : override;
}

function setGlobalParamFold(value) {
  state.paramCollapsedDefault = value !== 'expanded';
  state.collapsedModules[currentChannel] = {};
  renderParams();
}

function toggleModule(moduleName) {
  const current = isModuleCollapsed(currentChannel, moduleName);
  state.collapsedModules[currentChannel][moduleName] = !current;
  renderParams();
}

function renderParams() {
  const gridId = paramGridId();
  const grid = document.getElementById(gridId);
  if (!grid) return;
  const cfg = state.config[currentChannel];
  const version = state.configVersion[currentChannel] || '';
  if (typeof refreshDeviceSettingsUi === 'function') refreshDeviceSettingsUi();
  document.getElementById('versionBadge').textContent =
    `${t('config_version')}: ${version ? version.toUpperCase() : t('version_not_imported')}`;
  if (!cfg) {
    grid.innerHTML = `<div class="param-empty">${htmlEscape(t('import_empty'))}</div>`;
    return;
  }
  const rootKey = rootKeyForChannel(currentChannel);
  const root = cfg[rootKey];
  if (!root) {
    grid.innerHTML = `<div class="param-empty">${htmlEscape(t('config_missing_root').replace('{root}', rootKey))}</div>`;
    return;
  }

  grid.innerHTML = orderedModules(root, currentChannel, version).map(moduleName => {
    const value = root[moduleName];
    const entries = parameterEntries(moduleName, value);
    const collapsed = isModuleCollapsed(currentChannel, moduleName);
    const moduleArg = htmlEscape(jsString(moduleName));
    return `<div class="card ${collapsed ? 'collapsed' : ''}" data-module="${htmlEscape(moduleName)}">
      <div class="card-head">
        <div class="card-title">
          <button type="button" onclick="toggleModule('${moduleArg}')" title="${collapsed ? htmlEscape(t('expand')) : htmlEscape(t('collapse'))}">${collapsed ? '▶' : '▼'}</button>
          <span title="${htmlEscape(moduleName)}">${htmlEscape(moduleName)}</span>
        </div>
        <span class="card-count">${entries.length} ${htmlEscape(t('item_unit'))}</span>
      </div>
      <div class="card-body">${entries.map(item => paramRow(item.path, item.value)).join('')}</div>
    </div>`;
  }).join('');
}

function paramRow(path, value) {
  const text = valueToText(value);
  const name = displayName(path);
  const title = path.join('.');
  const input = value === 'enable' || value === 'disable'
    ? `<select class="param-input" data-path='${pathAttr(path)}' onchange="onParamInput(this)">
         <option value="enable" ${value === 'enable' ? 'selected' : ''}>enable</option>
         <option value="disable" ${value === 'disable' ? 'selected' : ''}>disable</option>
       </select>`
    : `<input class="param-input" value="${htmlEscape(text)}" data-path='${pathAttr(path)}' oninput="onParamInput(this)">`;
  return `<div class="param-row">
    <label title="${htmlEscape(title)}">${htmlEscape(name)}</label>
    ${input}
    <span class="hint">${paramHint(path, value)}</span>
  </div>`;
}

function filterParamHint(path) {
  if (!path || path[0] !== 'filter')
    return '';
  const leaf = path[path.length - 1];

  if (leaf === 'type')
    return '0:APF 1:LPF 2:HPF 3:BSF 4:BPF 5:BPFP 6:PEQ 7:LSF 8:HSF 9:HPF+LPF 10:LSF+HSF';
  if (leaf === 'mode' || leaf === 'mode1')
    return '0:BW 1:Q 2:S';
  if (leaf === 'fc' || leaf === 'fc1')
    return 'Hz';
  if (leaf === 'bw' || leaf === 'bw1')
    return 'bandwidth / Q';
  if (leaf === 'gain' || leaf === 'gain1' || leaf === 'post_gain')
    return 'dB';
  if (leaf === 'slope' || leaf === 'slope1')
    return 'slope';
  return '';
}

function paramHint(path, value) {
  const filterHint = filterParamHint(path);
  if (filterHint) return filterHint;
  if (path && path.includes('agc') && typeof value === 'number')
    return Number.isInteger(value) ? 'float (integer)' : 'float';
  if (value === 'enable' || value === 'disable') return 'enable / disable';
  if (Array.isArray(value)) return `${value.length} values`;
  if (typeof value === 'number') return Number.isInteger(value) ? 'integer' : 'float';
  if (typeof value === 'string' && value.startsWith('float:')) return 'float';
  return 'text';
}

function onParamInput(el) {
  const cfg = state.config[currentChannel];
  if (!cfg) return;
  const root = cfg[rootKeyForChannel(currentChannel)];
  const path = JSON.parse(el.dataset.path);
  const oldValue = getValueByPath(root, path);
  const newValue = textToValue(el.value, oldValue);
  if (typeof oldValue === 'number' && !Number.isFinite(Number(el.value))) {
    el.classList.add('invalid');
    return;
  }
  el.classList.remove('invalid');
  setValueByPath(root, path, newValue);
  if (typeof notifyOnlineParamChange === 'function')
    notifyOnlineParamChange();
}

// ── connect ──
function setConnectionState(connected) {
  state.connected = connected;
  document.getElementById('connStatus').textContent = connected ? t('connected') : t('disconnected');
  document.getElementById('connStatus').style.color = connected ? 'var(--green-dark)' : 'var(--muted)';
  document.getElementById('btnConnect').textContent = connected ? t('disconnect') : t('connect');
  document.getElementById('btnConnSmall').textContent = connected ? t('disconnect') : t('connect');
}

async function toggleConnect() {
  if (state.connected) {
    if (bridgeIsOpen()) {
      try { await sendBridgeCommand('device.disconnect', { target: currentBridgeTarget() }); }
      catch (err) { log('Bridge 断开设备失败: ' + err.message); }
    }
    setConnectionState(false);
    log('断开连接');
  } else {
    const target = currentBridgeTarget();
    state.adbDevice = target.adbDevice;
    if (await connectBridge()) {
      try {
        const info = await sendBridgeCommand('device.connect', { target }, 8000);
        setConnectionState(true);
        log('Bridge 连接设备: ' + (target.adbDevice || target.host || target.mode));
        detectSoc(info);
        return;
      } catch (err) {
        log('Bridge 连接设备失败，进入演示连接: ' + err.message);
      }
    }
    setConnectionState(true);
    log('演示连接: ' + (target.adbDevice || target.host || target.mode));
    detectSoc();
  }
}

function detectSoc(info) {
  state.socProfile = info && info.soc ? info.soc : 'rv1106';
  const sr = info && info.sampleRate ? info.sampleRate : 16000;
  document.getElementById('metRate').textContent = sr / 1000 + 'k';
  document.getElementById('metLatency').textContent = info && info.latencyMs ? info.latencyMs + ' ms' : '-- ms';
  // Update device settings from detected audio info
  if (info) {
    ['tx', 'rx'].forEach(ch => {
      const s = state.deviceSettings[ch];
      s.sampleRate = sr;
      if (ch === 'tx') {
        if (info.micChannels != null) s.micChannels = Number(info.micChannels) || 0;
        if (info.refChannels != null) s.refChannels = Number(info.refChannels) || 0;
        s.inputChannels = s.micChannels + s.refChannels;
      }
    });
  }
  if (typeof refreshDeviceSettingsUi === 'function') refreshDeviceSettingsUi();
  log('SoC: ' + state.socProfile + ' | ' + sr + 'Hz');
}

async function applyParams() {
  const cfg = state.config[currentChannel];
  if (!cfg) {
    alert('请先导入当前通道配置');
    return false;
  }
  if (!bridgeIsOpen()) {
    log('本地 Bridge 未连接，参数仅已写回浏览器内存');
    return false;
  }
  try {
    await sendBridgeCommand('params.apply', {
      channel: currentChannel.toUpperCase(),
      version: state.configVersion[currentChannel],
      config: cfg,
      target: currentBridgeTarget(),
    }, 40000);
    log('参数已通过 Bridge 下发: ' + currentChannel.toUpperCase());
    return true;
  } catch (err) {
    log('参数下发失败: ' + err.message);
    return false;
  }
}

// ── param floating window ──
let paramUpdateMode = 'manual';
let paramAutoUpdateTimer = null;
let paramApplyInFlight = false;
let paramApplyQueued = false;
let paramConfigDirty = false;

function openParamWindow(ch) {
  const dlg = document.getElementById('paramDialog');
  if (!dlg) return;
  state.paramWindowOpen = true;
  dlg.classList.add('open');
  // Position below RX online panel, or bottom-right by default
  const dialog = dlg.querySelector('.dialog');
  dialog.style.right = '24px';
  dialog.style.bottom = 'auto';
  dialog.style.left = 'auto';
  dialog.style.top = 'auto';
  const rxPanel = onlinePanels['rx'];
  if (rxPanel && rxPanel.root && rxPanel.root.classList.contains('open')) {
    const rxDialog = rxPanel.root.querySelector('.dialog');
    if (rxDialog) {
      const rxRect = rxDialog.getBoundingClientRect();
      const gap = 12;
      const top = rxRect.bottom + gap;
      if (top + 200 < window.innerHeight) {
        dialog.style.top = top + 'px';
      } else {
        dialog.style.bottom = '24px';
      }
    }
  } else {
    dialog.style.bottom = '24px';
  }
  // Select the requested channel (or sync from main page if no ch given)
  const targetCh = ch || currentChannel;
  // Hide/show tabs: if opened from online simulation (ch provided), show only that tab
  const tabs = document.getElementById('paramWindowTabs');
  if (tabs) tabs.style.display = ch ? 'none' : '';
  document.querySelectorAll('#paramWindowTabs .tab').forEach(t => t.classList.remove('active'));
  const twin = document.querySelector(`#paramWindowTabs .tab[data-tab="${targetCh}"]`);
  if (twin) twin.classList.add('active');
  if (targetCh !== currentChannel) {
    currentChannel = targetCh;
    // Sync main page tabs too
    document.querySelectorAll('#pageTuning .tabs .tab').forEach(t => t.classList.remove('active'));
    const mainTab = document.querySelector(`#pageTuning .tabs .tab[data-tab="${targetCh}"]`);
    if (mainTab) mainTab.classList.add('active');
  }
  bindParamWindowControls();
  renderParams();
  initParamWindowDrag();
}

function closeParamWindow() {
  const dlg = document.getElementById('paramDialog');
  if (!dlg) return;
  state.paramWindowOpen = false;
  dlg.classList.remove('open');
  // Restore tabs visibility
  const tabs = document.getElementById('paramWindowTabs');
  if (tabs) tabs.style.display = '';
  renderParams();
  if (typeof refreshDeviceSettingsUi === 'function') refreshDeviceSettingsUi();
}

function bindParamWindowControls() {
  const dlg = document.getElementById('paramDialog');
  if (!dlg || dlg._controlsBound) return;
  dlg._controlsBound = true;
  const resetBtn = dlg.querySelector('.param-reset');
  const modeSel = dlg.querySelector('.param-update-mode');
  const applyBtn = dlg.querySelector('.param-apply');
  if (resetBtn) resetBtn.addEventListener('click', () => {
    if (paramAutoUpdateTimer) { clearTimeout(paramAutoUpdateTimer); paramAutoUpdateTimer = null; }
    if (typeof restoreImportedConfig !== 'function') return;
    if (!restoreImportedConfig(currentChannel)) {
      alert(t('reset_failed'));
      setParamStatus(t('reset_failed'));
      return;
    }
    setParamStatus(t('params_reset_hint'));
  });
  if (modeSel) {
    modeSel.value = paramUpdateMode;
    modeSel.addEventListener('change', () => {
      paramUpdateMode = modeSel.value;
      if (paramUpdateMode === 'auto' && paramConfigDirty) handleParamApply();
    });
  }
  if (applyBtn) applyBtn.addEventListener('click', () => handleParamApply());
}

function setParamStatus(msg) {
  const el = document.querySelector('#paramDialog .param-status');
  if (el) el.textContent = msg || '';
}

async function handleParamApply() {
  if (paramAutoUpdateTimer) { clearTimeout(paramAutoUpdateTimer); paramAutoUpdateTimer = null; }
  if (paramApplyInFlight) {
    paramApplyQueued = true;
    setParamStatus(t('apply_params_queued'));
    return;
  }
  if (typeof applyParams !== 'function') return;
  paramApplyInFlight = true;
  try {
    do {
      paramApplyQueued = false;
      setParamStatus(t('applying_params'));
      if (!await applyParams()) {
        setParamStatus(t('apply_params_failed'));
        return;
      }
    } while (paramApplyQueued);
    paramConfigDirty = false;
    setParamStatus(t('update_params') + ' OK');
  } finally {
    paramApplyInFlight = false;
  }
}

function notifyOnlineParamChange() {
  if (!state.paramWindowOpen) return;
  paramConfigDirty = true;
  if (paramUpdateMode === 'auto') {
    if (paramAutoUpdateTimer) clearTimeout(paramAutoUpdateTimer);
    paramAutoUpdateTimer = setTimeout(() => {
      paramAutoUpdateTimer = null;
      handleParamApply();
    }, 450);
  } else {
    setParamStatus(t('param_changed_hint'));
  }
}

function initParamWindowDrag() {
  const dlg = document.getElementById('paramDialog');
  if (!dlg || dlg._dragInit) return;
  dlg._dragInit = true;
  const header = dlg.querySelector('.param-dialog-header');
  if (!header) return;
  let dragging = false, startX, startY, startLeft, startTop;
  header.addEventListener('pointerdown', e => {
    if (e.target.closest('.tabs') || e.target.closest('button') || e.target.closest('select')) return;
    dragging = true;
    const rect = dlg.querySelector('.dialog').getBoundingClientRect();
    startX = e.clientX;
    startY = e.clientY;
    startLeft = rect.left;
    startTop = rect.top;
    header.setPointerCapture(e.pointerId);
    e.preventDefault();
  });
  header.addEventListener('pointermove', e => {
    if (!dragging) return;
    const dx = e.clientX - startX;
    const dy = e.clientY - startY;
    const dialog = dlg.querySelector('.dialog');
    dialog.style.right = 'auto';
    dialog.style.bottom = 'auto';
    dialog.style.left = Math.max(0, Math.min(window.innerWidth - dialog.offsetWidth, startLeft + dx)) + 'px';
    dialog.style.top = Math.max(0, Math.min(window.innerHeight - 60, startTop + dy)) + 'px';
  });
  header.addEventListener('pointerup', () => { dragging = false; });
  header.addEventListener('pointercancel', () => { dragging = false; });
}
