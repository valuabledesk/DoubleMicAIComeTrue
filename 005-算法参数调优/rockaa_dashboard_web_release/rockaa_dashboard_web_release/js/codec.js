// ── codec mixer debugging ──
const codecState = {
  panel: null,
  loading: false,
};

function codecDialogHtml() {
  return `<div class="dialog" style="width:min(900px,calc(100vw - 48px));max-height:88vh">
    <div class="dialog-header">
      <h2 class="codec-title">${htmlEscape(t('codec_debug'))}</h2>
      <button class="btn sm codec-close" type="button">${htmlEscape(t('close'))}</button>
    </div>
    <div class="codec-toolbar">
      <span style="font-size:12px;font-weight:600;color:var(--muted)">${htmlEscape(t('codec_card'))}</span>
      <select class="field sm codec-card-select" style="min-width:240px"><option value="">--</option></select>
      <button class="btn sm green codec-refresh-btn" type="button">${htmlEscape(t('codec_refresh'))}</button>
      <span style="flex:1"></span>
      <span class="codec-status" style="font-size:12px;color:var(--muted)">${htmlEscape(t('ready'))}</span>
    </div>
    <div class="dialog-body codec-controls-body" style="padding:0;min-height:0;max-height:calc(88vh - 180px)">
      <div class="codec-placeholder" style="color:var(--muted);text-align:center;padding:60px 20px">${htmlEscape(t('codec_card'))}</div>
    </div>
    <div style="padding:4px 12px 8px;border-top:1px solid var(--line)">
      <div class="log-split-handle"></div>
      <div class="log codec-log" style="height:100px"></div>
    </div>
  </div>`;
}

function ensureCodecPanel() {
  if (codecState.panel) return codecState.panel;
  const root = document.createElement('div');
  root.className = 'dialog-overlay';
  root.id = 'codecDialog';
  root.innerHTML = codecDialogHtml();
  document.getElementById('codecDialogHost').appendChild(root);

  const panel = {
    root,
    refs: {
      title: root.querySelector('.codec-title'),
      cardSelect: root.querySelector('.codec-card-select'),
      refreshBtn: root.querySelector('.codec-refresh-btn'),
      close: root.querySelector('.codec-close'),
      status: root.querySelector('.codec-status'),
      body: root.querySelector('.codec-controls-body'),
      log: root.querySelector('.codec-log'),
    },
  };
  panel.refs.refreshBtn.addEventListener('click', () => refreshCodecCards());
  panel.refs.close.addEventListener('click', () => closeCodecDialog());
  panel.refs.cardSelect.addEventListener('change', () => refreshCodecControls());
  panel._logState = attachLogFeatures(panel.refs.log, 'rockaa_codec.log');
  if (typeof bindLogSplitters === 'function') bindLogSplitters();
  codecState.panel = panel;
  return panel;
}

function openCodecDialog() {
  const panel = ensureCodecPanel();
  panel.root.classList.add('open');
  refreshCodecCards();
}

function closeCodecDialog() {
  if (codecState.panel) codecState.panel.root.classList.remove('open');
  const codecNav = document.querySelector('.nav-item[data-page="codec"]');
  if (codecNav) codecNav.classList.remove('active');
  if (!document.querySelector('.nav-item.active[data-page]')) {
    const tuning = document.querySelector('.nav-item[data-page="tuning"]');
    if (tuning) tuning.classList.add('active');
  }
}

function codecSetStatus(text, error) {
  if (!codecState.panel) return;
  codecState.panel.refs.status.textContent = text;
  codecState.panel.refs.status.style.color = error ? 'var(--red)' : 'var(--muted)';
}

function codecLog(panel, message, error) {
  if (!panel || !panel.refs.log) return;
  const ts = new Date().toLocaleTimeString();
  const line = `[${ts}] ${message}`;
  if (panel._logState && panel._logState.paused) {
    panel._logState.pending.push(line);
    return;
  }
  if (panel.refs.log._highlighted) {
    panel.refs.log.textContent = panel.refs.log.textContent;
    panel.refs.log._highlighted = false;
  }
  appendLogLine(panel.refs.log, line);
}

function handleCodecLog(message) {
  if (codecState.panel && codecState.panel.root.classList.contains('open')) {
    codecLog(codecState.panel, message);
  } else {
    log('[Codec] ' + message);
  }
}

async function refreshCodecCards() {
  const panel = ensureCodecPanel();
  codecLog(panel, t('codec_loading'));
  codecSetStatus(t('codec_loading'));
  try {
    await ensureBridgeReady();
    const target = currentBridgeTarget();
    if (!target.adbDevice) throw new Error(t('no_adb_device'));
    const result = await sendBridgeCommand('codec.cards', { target }, 15000);
    const cards = result.cards || [];
    panel.refs.cardSelect.innerHTML = cards.length
      ? cards.map(c => `<option value="${c.index}">${c.index}: ${htmlEscape(c.name || c.id || 'card')}</option>`).join('')
      : `<option value="">${htmlEscape(t('codec_no_cards'))}</option>`;
    codecLog(panel, `Cards: ${cards.length}`);
    if (cards.length > 0) {
      refreshCodecControls();
    } else {
      codecSetStatus(t('codec_no_cards'), true);
    }
  } catch (err) {
    const msg = err && err.message ? err.message : String(err);
    codecLog(panel, msg, true);
    codecSetStatus(msg, true);
  }
}

async function refreshCodecControls() {
  const panel = ensureCodecPanel();
  const card = panel.refs.cardSelect.value;
  if (card === '') return;
  codecSetStatus(t('codec_loading'));
  panel.refs.body.innerHTML = `<div style="color:var(--muted);text-align:center;padding:40px">${htmlEscape(t('codec_loading'))}</div>`;
  try {
    const target = currentBridgeTarget();
    const result = await sendBridgeCommand('codec.list', { target, card: Number(card) }, 30000);
    renderCodecControls(result);
    codecSetStatus(`${result.mixerName || ''} — ${result.controls.length} ${t('codec_mixer')}`);
    codecLog(panel, `${result.mixerName || 'Mixer'}: ${result.controls.length} controls`);
  } catch (err) {
    const msg = err && err.message ? err.message : String(err);
    codecLog(panel, msg, true);
    codecSetStatus(msg, true);
    panel.refs.body.innerHTML = `<div style="color:var(--red);text-align:center;padding:40px">${htmlEscape(msg)}</div>`;
  }
}

function renderCodecControls(data) {
  const panel = codecState.panel;
  if (!panel) return;
  const controls = data.controls || [];
  panel.refs.body.innerHTML = controls.map(ctl => renderCodecRow(ctl)).join('');
  panel.refs.body.querySelectorAll('.codec-ctl-input').forEach(el => {
    el.addEventListener('change', () => onCodecControlChange(el));
  });
}

function renderCodecRow(ctl) {
  const num = ctl.num;
  const type = ctl.type;
  const name = htmlEscape(ctl.name);
  let valueHtml;
  if (type === 'ENUM') {
    const opts = (ctl.options || []).map((opt, i) =>
      `<option value="${i}" ${i === ctl.selectedIndex ? 'selected' : ''}>${htmlEscape(opt)}</option>`).join('');
    valueHtml = `<select class="codec-ctl-input" data-num="${num}" data-type="${type}" data-name="${name}" data-count="${ctl.count}">${opts}</select>`;
  } else if (type === 'BOOL') {
    valueHtml = `<select class="codec-ctl-input" data-num="${num}" data-type="${type}" data-name="${name}" data-count="${ctl.count}">`
      + `<option value="1" ${ctl.value ? 'selected' : ''}>On</option>`
      + `<option value="0" ${!ctl.value ? 'selected' : ''}>Off</option></select>`;
  } else if (type === 'INT' || type === 'INT64') {
    const vals = ctl.values || [];
    const range = ctl.range || {};
    const min = range.min != null ? `min="${range.min}"` : '';
    const max = range.max != null ? `max="${range.max}"` : '';
    const rangeText = range.min != null ? `<span class="codec-ctl-range">(${range.min}~${range.max})</span>` : '';
    valueHtml = vals.map((v, i) =>
      `<input type="number" class="codec-ctl-input" data-num="${num}" data-type="${type}" data-name="${name}" data-count="${ctl.count}" data-idx="${i}" value="${v}" ${min} ${max}>`
    ).join('') + rangeText;
  } else {
    const vals = (ctl.values || ctl.textValue || []).join(' ');
    valueHtml = `<span style="font-family:monospace;color:var(--muted)">${htmlEscape(String(vals))}</span>`;
  }
  return `<div class="codec-control-row">
    <span class="codec-ctl-num">${num}</span>
    <span class="codec-ctl-type ${type}">${type}</span>
    <span class="codec-ctl-name" title="${name}">${name}</span>
    <span class="codec-ctl-value">${valueHtml}</span>
  </div>`;
}

async function onCodecControlChange(el) {
  const panel = codecState.panel;
  if (!panel) return;
  const num = el.dataset.num;
  const type = el.dataset.type;
  const name = el.dataset.name;
  const card = Number(panel.refs.cardSelect.value);

  let values;
  if (type === 'ENUM') {
    values = [el.value];
  } else if (type === 'BOOL') {
    values = [el.value];
  } else if (type === 'INT' || type === 'INT64') {
    const inputs = panel.refs.body.querySelectorAll(`.codec-ctl-input[data-num="${num}"]`);
    values = Array.from(inputs).map(i => i.value);
  } else {
    return;
  }

  codecSetStatus(`${name} → ${values.join(' ')}`);
  try {
    const target = currentBridgeTarget();
    await sendBridgeCommand('codec.set', { target, card, name, values }, 10000);
    codecLog(panel, `${t('codec_set_ok')}: ${name} = ${values.join(' ')}`);
    codecSetStatus(`${name} = ${values.join(' ')}`);
  } catch (err) {
    const msg = err && err.message ? err.message : String(err);
    codecLog(panel, `${t('codec_set_failed')}: ${name}: ${msg}`, true);
    codecSetStatus(`${t('codec_set_failed')}: ${name}`, true);
  }
}

function refreshCodecLanguage() {
  if (!codecState.panel) return;
  const panel = codecState.panel;
  panel.refs.title.textContent = t('codec_debug');
  panel.refs.close.textContent = t('close');
  panel.refs.refreshBtn.textContent = t('codec_refresh');
}
