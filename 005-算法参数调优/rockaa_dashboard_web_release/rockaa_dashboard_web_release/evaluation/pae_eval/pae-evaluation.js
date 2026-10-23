const paeState = {
  panel: null,
  running: false,
  baseReportHtml: '',
  reportHtml: '',
  photos: [],
  metrics: null,
  project: null,
  projectDialog: null,
  cancelRequested: false,
  stopping: false,
};

const PAE_PHOTO_ROLES = ['front', 'side', 'top'];
const PAE_PROJECT_STORAGE_KEY = 'rockaa_pae_project_profile_v2';
const PAE_PROJECT_WEIGHTS = {
  structure: 0.30,
  microphone: 0.25,
  speaker: 0.25,
  scenario: 0.20,
};
const PAE_PROJECT_REQUIRED = [
  'socPlatform', 'micSpeakerDistance', 'micCount', 'micType', 'micSensitivity',
  'speakerCount', 'speakerPower', 'speakerImpedance', 'sampleRate', 'assemblyState',
  'pickupMinDistance', 'pickupMaxDistance',
];

function emptyPaeProject() {
  const tx = typeof state !== 'undefined' && state.deviceSettings && state.deviceSettings.tx
    ? state.deviceSettings.tx : {};
  return {
    socPlatform: 'RK3308', micSpeakerDistance: '50',
    micCount: String(tx.micChannels || 1), micType: 'analog_ecm', micSensitivity: '-38',
    speakerCount: String(tx.refChannels == null ? 1 : tx.refChannels),
    speakerPower: '2.0', speakerImpedance: '8', sampleRate: '16000',
    assemblyState: 'bare', pickupMinDistance: '100', pickupMaxDistance: '200',
  };
}

function loadPaeProject() {
  if (paeState.project) return paeState.project;
  paeState.project = emptyPaeProject();
  try {
    const saved = typeof window !== 'undefined' && window.localStorage
      ? window.localStorage.getItem(PAE_PROJECT_STORAGE_KEY) : '';
    if (saved) Object.assign(paeState.project, JSON.parse(saved));
    if (paeState.project.socPlatform === 'RV1126') paeState.project.socPlatform = 'RV1126B';
  } catch (error) {
    paeState.project = emptyPaeProject();
  }
  return paeState.project;
}

function savePaeProject(project) {
  paeState.project = Object.assign(emptyPaeProject(), project);
  try {
    if (typeof window !== 'undefined' && window.localStorage)
      window.localStorage.setItem(PAE_PROJECT_STORAGE_KEY, JSON.stringify(paeState.project));
  } catch (error) {
    paeLog(error.message || String(error), true);
  }
  updatePaeProjectBar();
  composePaeReport();
}

function paeProjectValidation(project) {
  const missing = PAE_PROJECT_REQUIRED.filter((key) => String(project[key] || '').trim() === '');
  const blocking = [];
  if (Number(project.micCount) < 1) blocking.push('mic_count');
  if (Number(project.speakerCount) < 0) blocking.push('speaker_count');
  if (Number(project.speakerPower) <= 0 || Number(project.speakerImpedance) <= 0) blocking.push('speaker_spec');
  if (Number(project.pickupMinDistance) > Number(project.pickupMaxDistance)) blocking.push('pickup_range');
  return { missing, blocking, valid: missing.length === 0 && blocking.length === 0 };
}

function paeProjectWarnings(project) {
  const warnings = [];
  if (project.assemblyState === 'bare') warnings.push(t('pae_project_warn_bare'));
  if (project.sampleRate && Number(project.sampleRate) !== 16000) warnings.push(t('pae_project_warn_rate'));
  warnings.push(t('pae_project_warn_sensitivity'));
  return warnings;
}

function paeProjectScore(project) {
  const dimensions = {
    structure: (project.assemblyState === 'final' ? 60 : project.assemblyState === 'prototype' ? 40 : 20)
      + (project.micSpeakerDistance ? 20 : 0) + (project.pickupMinDistance && project.pickupMaxDistance ? 20 : 0),
    microphone: (project.micCount ? 30 : 0) + (project.micType ? 35 : 0) + (project.micSensitivity ? 35 : 0),
    speaker: (project.speakerCount ? 20 : 0) + (project.speakerPower ? 40 : 0) + (project.speakerImpedance ? 40 : 0),
    scenario: (project.socPlatform ? 50 : 0) + (project.sampleRate ? 50 : 0),
  };
  let total = Math.round(Object.keys(PAE_PROJECT_WEIGHTS)
    .reduce((score, key) => score + dimensions[key] * PAE_PROJECT_WEIGHTS[key], 0));
  if (project.assemblyState === 'bare') total = Math.min(total, 59);
  else if (project.assemblyState === 'prototype') total = Math.min(total, 79);
  if (project.sampleRate && Number(project.sampleRate) !== 16000) total = Math.min(total, 79);
  return { dimensions, total, level: total >= 80 ? 'high' : total >= 60 ? 'medium' : 'low' };
}

function paeMaxUndistortedVoltage(project) {
  const power = Number(project.speakerPower);
  const impedance = Number(project.speakerImpedance);
  return power > 0 && impedance > 0 ? Math.sqrt(power * impedance).toFixed(2) : '--';
}

function renderEvalMarkdown(markdown, images) {
  let html = markdown;
  const imageMap = images || {};
  html = html.replace(/!\[([^\]]*)\]\(([^)]+)\)/g, (match, alt, src) => {
    const basename = src.split('/').pop();
    const dataUri = imageMap[basename] || imageMap[src];
    return dataUri
      ? `<img alt="${htmlEscape(alt)}" src="${dataUri}">`
      : `<div style="color:var(--muted)">[missing: ${htmlEscape(src)}]</div>`;
  });
  const output = [];
  let inList = false;
  for (const line of html.split('\n')) {
    const closeList = () => {
      if (inList) { output.push('</ul>'); inList = false; }
    };
    if (/^###\s+/.test(line)) {
      closeList(); output.push(`<h4>${line.replace(/^###\s+/, '')}</h4>`);
    } else if (/^##\s+/.test(line)) {
      closeList(); output.push(`<h3>${line.replace(/^##\s+/, '')}</h3>`);
    } else if (/^#\s+/.test(line)) {
      closeList(); output.push(`<h3>${line.replace(/^#\s+/, '')}</h3>`);
    } else if (/^- /.test(line)) {
      if (!inList) { output.push('<ul>'); inList = true; }
      output.push(`<li>${line.replace(/^- /, '')}</li>`);
    } else if (!line.trim()) {
      closeList(); output.push('');
    } else if (line.startsWith('<img')) {
      closeList(); output.push(line);
    } else {
      closeList(); output.push(`<p>${line}</p>`);
    }
  }
  if (inList) output.push('</ul>');
  return output.join('\n')
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/`([^`]+)`/g, '<code>$1</code>');
}

function paeDialogHtml() {
  return `<div class="dialog" style="width:min(1180px,calc(100vw - 48px));max-height:94vh">
    <div class="dialog-header">
      <h2 class="pae-title">${htmlEscape(t('pae_title'))}</h2>
      <button class="btn sm pae-close" type="button">${htmlEscape(t('close'))}</button>
    </div>
    <div class="pae-project-bar" style="padding:8px 20px;display:flex;align-items:center;gap:10px;border-bottom:1px solid var(--line);background:var(--panel-soft)">
      <strong class="pae-project-label">${htmlEscape(t('pae_project'))}</strong>
      <span class="pae-project-summary" style="font-size:12px;color:var(--muted);flex:1">${htmlEscape(t('pae_project_missing'))}</span>
      <button class="btn sm pae-project-edit" type="button">${htmlEscape(t('pae_project_fill'))}</button>
    </div>
    <div class="eval-toolbar">
      <label class="pae-duration-label">${htmlEscape(t('pae_duration'))}</label>
      <select class="field sm pae-duration">
        <option value="3">3 s</option><option value="5" selected>5 s</option><option value="8">8 s</option>
      </select>
      <label class="pae-start-hz-label">${htmlEscape(t('pae_start_hz'))}</label>
      <input class="field sm pae-start-hz" type="number" min="40" max="1000" step="10" value="80" style="width:78px">
      <label class="pae-end-hz-label">${htmlEscape(t('pae_end_hz'))}</label>
      <input class="field sm pae-end-hz" type="number" min="1000" max="7200" step="100" value="7200" style="width:84px">
      <button class="btn sm green pae-start" type="button">${htmlEscape(t('pae_start'))}</button>
      <label class="btn sm pae-photo-button"><span class="pae-photo-button-text">${htmlEscape(t('pae_photos'))}</span>
        <input class="pae-photo-input" type="file" accept="image/jpeg,image/png,image/webp" multiple hidden>
      </label>
      <span class="pae-photo-status" style="font-size:12px;color:var(--muted)">${htmlEscape(t('pae_photos_empty'))}</span>
      <span class="pae-scope-hint" style="font-size:12px;color:var(--muted)">${htmlEscape(t('pae_scope_hint'))}</span>
      <span style="flex:1"></span>
      <span class="pae-status" style="font-size:12px;color:var(--muted)">${htmlEscape(t('pae_ready'))}</span>
      <button class="btn sm pae-export" type="button" hidden>${htmlEscape(t('pae_export'))}</button>
    </div>
    <div class="dialog-body eval-report-body" style="padding:0;min-height:0;display:grid;grid-template-rows:1fr auto;overflow:hidden">
      <div class="eval-report-scroll pae-report-scroll" style="overflow-y:auto;padding:12px 20px;min-height:240px">
        <div class="eval-report-content pae-report-content eval-placeholder" style="color:var(--muted);text-align:center;padding:60px 20px">${htmlEscape(t('pae_ready'))}</div>
      </div>
      <div style="padding:4px 12px 8px;border-top:1px solid var(--line)">
        <div class="log-split-handle"></div>
        <div class="log pae-log" style="height:130px"></div>
      </div>
    </div>
  </div>`;
}

function ensurePaePanel() {
  if (paeState.panel) return paeState.panel;
  const root = document.createElement('div');
  root.className = 'dialog-overlay';
  root.id = 'paeDialog';
  root.innerHTML = paeDialogHtml();
  document.body.appendChild(root);
  const panel = {
    root,
    refs: {
      title: root.querySelector('.pae-title'),
      projectLabel: root.querySelector('.pae-project-label'),
      projectSummary: root.querySelector('.pae-project-summary'),
      projectEdit: root.querySelector('.pae-project-edit'),
      durationLabel: root.querySelector('.pae-duration-label'),
      duration: root.querySelector('.pae-duration'),
      startHzLabel: root.querySelector('.pae-start-hz-label'),
      startHz: root.querySelector('.pae-start-hz'),
      endHzLabel: root.querySelector('.pae-end-hz-label'),
      endHz: root.querySelector('.pae-end-hz'),
      start: root.querySelector('.pae-start'),
      photoButton: root.querySelector('.pae-photo-button'),
      photoButtonText: root.querySelector('.pae-photo-button-text'),
      photoInput: root.querySelector('.pae-photo-input'),
      photoStatus: root.querySelector('.pae-photo-status'),
      close: root.querySelector('.pae-close'),
      status: root.querySelector('.pae-status'),
      exportReport: root.querySelector('.pae-export'),
      scopeHint: root.querySelector('.pae-scope-hint'),
      reportContent: root.querySelector('.pae-report-content'),
      log: root.querySelector('.pae-log'),
    },
  };
  panel.refs.start.addEventListener('click', startPaeEvaluation);
  panel.refs.projectEdit.addEventListener('click', openPaeProjectDialog);
  panel.refs.photoInput.addEventListener('change', importPaePhotos);
  panel.refs.exportReport.addEventListener('click', exportPaeReport);
  panel.refs.close.addEventListener('click', closePaeDialog);
  panel._logState = attachLogFeatures(panel.refs.log, 'rockaa_pae.log');
  if (typeof bindLogSplitters === 'function') bindLogSplitters();
  paeState.panel = panel;
  loadPaeProject();
  updatePaeProjectBar();
  return panel;
}

function paeProjectOption(value, label, selected) {
  return `<option value="${value}"${selected === value ? ' selected' : ''}>${htmlEscape(label)}</option>`;
}

function paeProjectSelect(name, labelKey, options, required, includePlaceholder) {
  const project = loadPaeProject();
  const placeholder = includePlaceholder ? paeProjectOption('', t('pae_project_select'), project[name]) : '';
  return `<label style="display:grid;gap:4px"><span>${htmlEscape(t(labelKey))}${required ? ' *' : ''}</span><select class="field sm" data-project-field="${name}">${placeholder}${options.map(([value, key]) => paeProjectOption(value, t(key), project[name])).join('')}</select></label>`;
}

function paeProjectInput(name, labelKey, required, type, min, step) {
  const project = loadPaeProject();
  return `<label style="display:grid;gap:4px"><span>${htmlEscape(t(labelKey))}${required ? ' *' : ''}</span><input class="field sm" data-project-field="${name}" type="${type || 'text'}"${min !== undefined ? ` min="${min}"` : ''}${step !== undefined ? ` step="${step}"` : ''} value="${htmlEscape(project[name] || '')}"></label>`;
}

function paeProjectDialogHtml() {
  const project = loadPaeProject();
  const micTypes = [['analog_ecm', 'pae_project_mic_analog_ecm'], ['analog_mems', 'pae_project_mic_analog_mems'], ['digital_mems', 'pae_project_mic_digital_mems']];
  return `<div class="dialog" style="width:min(1000px,calc(100vw - 64px));max-height:90vh;overflow:auto">
    <div class="dialog-header"><h2>${htmlEscape(t('pae_project_title'))}</h2><button class="btn sm pae-project-cancel" type="button">${htmlEscape(t('close'))}</button></div>
    <div style="padding:16px 20px"><p style="margin:0 0 12px;color:var(--muted)">${htmlEscape(t('pae_project_intro'))}</p>
      <div class="pae-project-grid" style="display:grid;grid-template-columns:repeat(auto-fit,minmax(190px,1fr));gap:12px">
        ${paeProjectSelect('socPlatform', 'pae_project_soc', [['RK3308', 'pae_project_soc_rk3308'], ['RV1126B', 'pae_project_soc_rv1126b'], ['RV1106', 'pae_project_soc_rv1106'], ['RV1103', 'pae_project_soc_rv1103'], ['RV1106B', 'pae_project_soc_rv1106b'], ['RV1103B', 'pae_project_soc_rv1103b']], true, false)}
        ${paeProjectInput('micSpeakerDistance', 'pae_project_mic_spk_distance', true, 'number', 0, 1)}
        ${paeProjectInput('micCount', 'pae_project_mic_count', true, 'number', 1, 1)}
        ${paeProjectSelect('micType', 'pae_project_mic_type', micTypes, true, false)}
        ${paeProjectInput('micSensitivity', 'pae_project_mic_sensitivity_analog', true, 'number', undefined, 1)}
        ${paeProjectInput('speakerCount', 'pae_project_spk_count', true, 'number', 0, 1)}
        ${paeProjectSelect('sampleRate', 'pae_project_rate', [['8000', 'pae_project_rate_8k'], ['16000', 'pae_project_rate_16k'], ['32000', 'pae_project_rate_32k'], ['44100', 'pae_project_rate_44k'], ['48000', 'pae_project_rate_48k']], true, false)}
        ${paeProjectSelect('assemblyState', 'pae_project_assembly', [['bare', 'pae_project_bare'], ['prototype', 'pae_project_prototype'], ['final', 'pae_project_final']], true, false)}
        ${paeProjectInput('speakerPower', 'pae_project_spk_power', true, 'number', 0.1, 0.1)}
        ${paeProjectInput('speakerImpedance', 'pae_project_spk_impedance', true, 'number', 1, 1)}
        <label style="display:grid;gap:4px"><span>${htmlEscape(t('pae_project_spk_voltage'))}</span><output class="field sm pae-project-voltage" style="display:flex;align-items:center">${paeMaxUndistortedVoltage(project)} V</output></label>
        ${paeProjectInput('pickupMinDistance', 'pae_project_pickup_min', true, 'number', 0, 1)}
        ${paeProjectInput('pickupMaxDistance', 'pae_project_pickup_max', true, 'number', 0, 1)}
      </div>
      <p class="pae-project-manual-note" style="color:#b45309;margin:12px 0 0">${htmlEscape(t('pae_project_sensitivity_note'))}</p>
      <p class="pae-project-error" style="color:var(--red);min-height:20px"></p>
      <div style="display:flex;justify-content:flex-end;gap:8px"><button class="btn pae-project-cancel" type="button">${htmlEscape(t('cancel'))}</button><button class="btn green pae-project-save" type="button">${htmlEscape(t('pae_project_save'))}</button></div>
    </div></div>`;
}

function openPaeProjectDialog() {
  if (paeState.projectDialog) paeState.projectDialog.remove();
  const root = document.createElement('div');
  root.className = 'dialog-overlay open';
  root.style.zIndex = '1100';
  root.innerHTML = paeProjectDialogHtml();
  document.body.appendChild(root);
  const micType = root.querySelector('[data-project-field="micType"]');
  const sensitivity = root.querySelector('[data-project-field="micSensitivity"]');
  const sensitivityLabel = sensitivity.closest('label').querySelector('span');
  const refreshSensitivity = (resetValue) => {
    const digital = micType.value === 'digital_mems';
    sensitivityLabel.textContent = t(digital ? 'pae_project_mic_sensitivity_digital' : 'pae_project_mic_sensitivity_analog') + ' *';
    if (resetValue) sensitivity.value = digital ? '-26' : '-38';
  };
  const refreshVoltage = () => {
    root.querySelector('.pae-project-voltage').textContent = `${paeMaxUndistortedVoltage({
      speakerPower: root.querySelector('[data-project-field="speakerPower"]').value,
      speakerImpedance: root.querySelector('[data-project-field="speakerImpedance"]').value,
    })} V`;
  };
  micType.addEventListener('change', () => refreshSensitivity(true));
  root.querySelector('[data-project-field="speakerPower"]').addEventListener('input', refreshVoltage);
  root.querySelector('[data-project-field="speakerImpedance"]').addEventListener('input', refreshVoltage);
  refreshSensitivity(false);
  root.querySelectorAll('.pae-project-cancel').forEach((button) => button.addEventListener('click', () => { root.remove(); paeState.projectDialog = null; }));
  root.querySelector('.pae-project-save').addEventListener('click', () => {
    const project = emptyPaeProject();
    root.querySelectorAll('[data-project-field]').forEach((field) => { project[field.dataset.projectField] = field.value.trim(); });
    const validation = paeProjectValidation(project);
    if (!validation.valid) {
      const reasons = [];
      if (validation.missing.length) reasons.push(t('pae_project_required_error').replace('{count}', String(validation.missing.length)));
      if (validation.blocking.includes('mic_count')) reasons.push(t('pae_project_mic_count_error'));
      if (validation.blocking.includes('speaker_count')) reasons.push(t('pae_project_spk_count_error'));
      if (validation.blocking.includes('speaker_spec')) reasons.push(t('pae_project_spk_spec_error'));
      if (validation.blocking.includes('pickup_range')) reasons.push(t('pae_project_pickup_range_error'));
      root.querySelector('.pae-project-error').textContent = reasons.join(lang === 'en' ? ' ' : '；');
      return;
    }
    savePaeProject(project);
    root.remove();
    paeState.projectDialog = null;
  });
  paeState.projectDialog = root;
}

function updatePaeProjectBar() {
  if (!paeState.panel) return;
  const project = loadPaeProject();
  const validation = paeProjectValidation(project);
  const filled = PAE_PROJECT_REQUIRED.length - validation.missing.length;
  const summary = t('pae_project_summary').replace('{soc}', project.socPlatform)
    .replace('{mic}', project.micCount).replace('{spk}', project.speakerCount)
    .replace('{filled}', String(filled)).replace('{total}', String(PAE_PROJECT_REQUIRED.length));
  paeState.panel.refs.projectSummary.textContent = summary;
  paeState.panel.refs.projectSummary.style.color = validation.valid ? 'var(--muted)' : '#b45309';
  paeState.panel.refs.projectEdit.textContent = t('pae_project_edit');
}

function openPaeDialog() {
  const panel = ensurePaePanel();
  panel.root.classList.add('open');
  paeLog(t('pae_ready'));
}

function hidePaeDialog() {
  if (paeState.panel) paeState.panel.root.classList.remove('open');
  const nav = document.querySelector('.nav-item[data-page="pae"]');
  if (nav) nav.classList.remove('active');
  if (!document.querySelector('.nav-item.active[data-page]')) {
    const tuning = document.querySelector('.nav-item[data-page="tuning"]');
    if (tuning) tuning.classList.add('active');
  }
}

async function closePaeDialog() {
  if (!paeState.running) {
    hidePaeDialog();
    return;
  }
  if (paeState.stopping || !window.confirm(t('pae_close_confirm'))) return;
  const panel = ensurePaePanel();
  paeState.stopping = true;
  paeState.cancelRequested = true;
  panel.refs.close.disabled = true;
  panel.refs.status.hidden = false;
  panel.refs.status.style.color = 'var(--muted)';
  panel.refs.status.textContent = t('pae_stopping');
  try {
    await ensureBridgeReady();
    await sendBridgeCommand('pae.stop', { target: currentBridgeTarget() }, 15000);
    paeLog(t('pae_cancelled'));
    hidePaeDialog();
  } catch (error) {
    panel.refs.status.style.color = 'var(--red)';
    panel.refs.status.textContent = `${t('pae_stop_failed')}: ${error.message || error}`;
  } finally {
    paeState.stopping = false;
    panel.refs.close.disabled = false;
  }
}

function paeLog(message, error) {
  const panel = paeState.panel;
  if (!panel || !panel.refs.log) return;
  const line = `[${new Date().toLocaleTimeString()}] ${message}`;
  appendLogLine(panel.refs.log, line);
  if (error) panel.refs.status.style.color = 'var(--red)';
}

function handlePaeLog(message) {
  if (paeState.panel && paeState.panel.root.classList.contains('open')) paeLog(message);
  else log('[PAE] ' + message);
}

function setPaeRunning(running) {
  paeState.running = running;
  if (!paeState.panel) return;
  const refs = paeState.panel.refs;
  refs.start.disabled = running;
  refs.duration.disabled = running;
  refs.startHz.disabled = running;
  refs.endHz.disabled = running;
  refs.photoInput.disabled = running;
  refs.projectEdit.disabled = running;
  refs.close.disabled = paeState.stopping;
  refs.start.textContent = running ? t('pae_running') : t('pae_start');
}

function readPaePhoto(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve({ name: file.name, dataUri: reader.result });
    reader.onerror = () => reject(reader.error || new Error(file.name));
    reader.readAsDataURL(file);
  });
}

function renderPaePhotos() {
  const roleNames = {
    front: t('pae_photo_front'), side: t('pae_photo_side'), top: t('pae_photo_top'),
  };
  const roleShortNames = {
    front: t('pae_photo_front_short'), side: t('pae_photo_side_short'), top: t('pae_photo_top_short'),
  };
  const figures = paeState.photos.map((photo, index) =>
    `<figure class="pae-device-photo" data-photo-index="${index}" draggable="true" style="margin:0;break-inside:avoid;cursor:grab"><img alt="${htmlEscape(roleNames[PAE_PHOTO_ROLES[index]])}" src="${photo.dataUri}" style="width:100%;margin:0"><figcaption style="margin-top:6px;color:#475569;text-align:center"><strong>${htmlEscape(roleNames[PAE_PHOTO_ROLES[index]])}</strong><br><span style="font-size:12px">${htmlEscape(t('pae_photo_drag'))}</span></figcaption></figure>`
  ).join('');
  const missingRoles = PAE_PHOTO_ROLES.slice(paeState.photos.length).map((role) => roleShortNames[role]);
  const separator = lang === 'en' ? ', ' : '、';
  const missing = missingRoles.length
    ? `<p style="color:#b45309;font-weight:600">${htmlEscape(t('pae_missing_photos').replace('{views}', missingRoles.join(separator)))}</p>`
    : '';
  const grid = figures
    ? `<div class="pae-photo-grid" style="display:grid;grid-template-columns:repeat(auto-fit,minmax(240px,1fr));gap:16px">${figures}</div>`
    : '';
  return `<h3>${htmlEscape(t('pae_photos_title'))}</h3><p>${htmlEscape(t('pae_photos_note'))}</p>${missing}${grid}${renderPaePhotoAnalysis()}`;
}

function renderPaePhotoAnalysis() {
  const flags = new Set((paeState.metrics && paeState.metrics.diagnostic_flags) || []);
  const available = PAE_PHOTO_ROLES.slice(0, paeState.photos.length).map((role) => t(`pae_photo_${role}_short`));
  const evidence = available.length
    ? t('pae_photo_evidence').replace('{views}', available.join(lang === 'en' ? ', ' : '、'))
    : t('pae_photo_audio_only');
  const suggestions = [];
  if (flags.has('multitone')) suggestions.push(t('pae_photo_check_speaker'));
  if (flags.has('coherence') || flags.has('correlation')) suggestions.push(t('pae_photo_check_mic'));
  if (flags.has('clipping') || flags.has('snr')) suggestions.push(t('pae_photo_check_gain'));
  if (flags.has('reference')) suggestions.push(t('pae_photo_check_reference'));
  if (!suggestions.length) suggestions.push(t('pae_photo_check_normal'));
  return `<h4>${htmlEscape(t('pae_photo_analysis'))}</h4><p>${htmlEscape(evidence)}</p><ul>${suggestions.map((item) => `<li>${htmlEscape(item)}</li>`).join('')}</ul>`;
}

function bindPaePhotoDrag() {
  if (!paeState.panel) return;
  const figures = paeState.panel.refs.reportContent.querySelectorAll('.pae-device-photo');
  figures.forEach((figure) => {
    figure.addEventListener('dragstart', (event) => {
      event.dataTransfer.setData('text/plain', figure.dataset.photoIndex);
    });
    figure.addEventListener('dragover', (event) => event.preventDefault());
    figure.addEventListener('drop', (event) => {
      event.preventDefault();
      const source = Number(event.dataTransfer.getData('text/plain'));
      const target = Number(figure.dataset.photoIndex);
      swapPaePhotos(source, target);
    });
  });
}

function swapPaePhotos(source, target) {
  if (!Number.isInteger(source) || !Number.isInteger(target)
      || source === target || !paeState.photos[source] || !paeState.photos[target]) return;
  [paeState.photos[source], paeState.photos[target]] = [paeState.photos[target], paeState.photos[source]];
  composePaeReport();
}

function paeProjectDisplay(value, prefix) {
  if (!value) return t('pae_project_not_provided');
  const key = prefix ? `${prefix}${value}` : '';
  const translated = key ? t(key) : value;
  return translated === key ? value : translated;
}

function renderPaeProjectReport() {
  const project = loadPaeProject();
  const score = paeProjectScore(project);
  const warnings = paeProjectWarnings(project);
  const sensitivityUnit = project.micType === 'digital_mems' ? 'dBFS' : 'dBV';
  const rows = [
    [t('pae_project_soc'), project.socPlatform],
    [t('pae_project_assembly'), paeProjectDisplay(project.assemblyState, 'pae_project_')],
    [t('pae_project_rate'), `${project.sampleRate} Hz`],
    [t('pae_project_mic_spk_distance'), `${project.micSpeakerDistance} mm`],
    [t('pae_project_mic_count'), project.micCount],
    [t('pae_project_mic_type'), paeProjectDisplay(project.micType, 'pae_project_mic_')],
    [t('pae_project_mic_sensitivity'), `${project.micSensitivity} ${sensitivityUnit}`],
    [t('pae_project_spk_count'), project.speakerCount],
    [t('pae_project_spk_power'), `${Number(project.speakerPower).toFixed(1)} W`],
    [t('pae_project_spk_impedance'), `${project.speakerImpedance} Ω`],
    [t('pae_project_spk_voltage'), `${paeMaxUndistortedVoltage(project)} V`],
    [t('pae_project_pickup_range'), `${project.pickupMinDistance}–${project.pickupMaxDistance} cm`],
  ];
  const dimensionNames = {
    structure: t('pae_project_weight_structure'), microphone: t('pae_project_weight_microphone'),
    speaker: t('pae_project_weight_speaker'), scenario: t('pae_project_weight_scenario'),
  };
  const table = `<table style="border-collapse:collapse;width:100%"><tbody>${rows.map(([label, value]) => `<tr><th style="text-align:left;padding:4px 8px;border:1px solid #d8dee4;width:24%">${htmlEscape(label)}</th><td style="padding:4px 8px;border:1px solid #d8dee4">${htmlEscape(value)}</td></tr>`).join('')}</tbody></table>`;
  const dimensions = Object.keys(PAE_PROJECT_WEIGHTS).map((key) => `<li>${htmlEscape(dimensionNames[key])}: ${score.dimensions[key]}/100 × ${Math.round(PAE_PROJECT_WEIGHTS[key] * 100)}%</li>`).join('');
  const warningHtml = warnings.length
    ? `<h4>${htmlEscape(t('pae_project_missing_title'))}</h4><ul style="color:#b45309;font-weight:600">${warnings.map((warning) => `<li>${htmlEscape(warning)}</li>`).join('')}</ul>`
    : `<p style="color:#15803d">${htmlEscape(t('pae_project_data_complete'))}</p>`;
  return `<h3>${htmlEscape(t('pae_project_report'))}</h3>${table}<h4>${htmlEscape(t('pae_project_confidence'))}</h4><p><strong>${score.total}/100 · ${htmlEscape(t(`pae_project_level_${score.level}`))}</strong></p><ul>${dimensions}</ul><p>${htmlEscape(t('pae_project_score_note'))}</p>${warningHtml}`;
}

function composePaeReport() {
  if (!paeState.baseReportHtml) return;
  let html = paeState.baseReportHtml;
  const project = renderPaeProjectReport();
  const photos = renderPaePhotos();
  if (project) {
    const marker = /<h3>(?:设备实物照片|Device Photos|判定依据图|Diagnostic Decision Map|测试范围|Scope)<\/h3>/;
    html = marker.test(html) ? html.replace(marker, `${project}$&`) : `${html}${project}`;
  }
  if (photos) {
    const marker = /<h3>(?:判定依据图|Diagnostic Decision Map|测试范围|Scope)<\/h3>/;
    html = marker.test(html) ? html.replace(marker, `${photos}$&`) : `${html}${photos}`;
  }
  paeState.reportHtml = html;
  if (paeState.panel && html) {
    paeState.panel.refs.reportContent.innerHTML = html;
    bindPaePhotoDrag();
  }
}

async function importPaePhotos(event) {
  const panel = ensurePaePanel();
  const files = Array.from(event.target.files || []);
  const valid = files.length <= 3 && files.every((file) => /^image\/(jpeg|png|webp)$/.test(file.type))
    && files.reduce((total, file) => total + file.size, 0) <= 30 * 1024 * 1024;
  if (!valid) {
    panel.refs.photoStatus.textContent = t('pae_photos_limit');
    panel.refs.photoStatus.style.color = 'var(--red)';
    event.target.value = '';
    return;
  }
  try {
    paeState.photos = await Promise.all(files.map(readPaePhoto));
    panel.refs.photoStatus.textContent = files.length
      ? t('pae_photos_count').replace('{count}', String(files.length))
      : t('pae_photos_empty');
    panel.refs.photoStatus.style.color = 'var(--muted)';
    composePaeReport();
  } catch (error) {
    panel.refs.photoStatus.textContent = error.message || String(error);
    panel.refs.photoStatus.style.color = 'var(--red)';
  }
}

function exportPaeReport() {
  if (!paeState.reportHtml) return;
  const reportTitle = t('pae_report');
  const documentHtml = `<!doctype html>
<html lang="${lang === 'en' ? 'en' : 'zh-CN'}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${htmlEscape(reportTitle)}</title>
<style>
body{max-width:1100px;margin:32px auto;padding:0 24px;color:#17212b;font:15px/1.65 system-ui,-apple-system,"Segoe UI",sans-serif}
h1,h2,h3,h4{color:#17212b;border-bottom:1px solid #d8dee4;padding-bottom:.3em}code{background:#f2f4f7;padding:2px 5px;border-radius:4px}
img{display:block;max-width:100%;height:auto;margin:18px auto;break-inside:avoid}ul{padding-left:24px}@media print{body{margin:0;max-width:none}img{max-height:92vh;object-fit:contain}}
</style>
</head>
<body>${paeState.reportHtml}</body>
</html>`;
  const blob = new Blob([documentHtml], { type: 'text/html;charset=utf-8' });
  const link = document.createElement('a');
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  link.href = URL.createObjectURL(blob);
  link.download = `rockaa-evaluation-report-${timestamp}.html`;
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(link.href), 1000);
}

async function startPaeEvaluation() {
  if (paeState.running) return;
  const panel = ensurePaePanel();
  const validation = paeProjectValidation(loadPaeProject());
  if (!validation.valid) {
    panel.refs.status.hidden = false;
    panel.refs.status.style.color = '#b45309';
    panel.refs.status.textContent = t('pae_project_complete_before_start');
    openPaeProjectDialog();
    return;
  }
  const duration = Number(panel.refs.duration.value) || 5;
  const startHz = Number(panel.refs.startHz.value) || 80;
  const endHz = Number(panel.refs.endHz.value) || 7200;
  setPaeRunning(true);
  paeState.cancelRequested = false;
  paeState.baseReportHtml = '';
  paeState.reportHtml = '';
  paeState.metrics = null;
  panel.refs.exportReport.hidden = true;
  panel.refs.status.hidden = false;
  panel.refs.log.textContent = '';
  panel.refs.status.textContent = t('pae_prepare');
  panel.refs.status.style.color = 'var(--muted)';
  panel.refs.reportContent.className = 'eval-report-content pae-report-content eval-placeholder';
  panel.refs.reportContent.style.cssText = 'color:var(--muted);text-align:center;padding:60px 20px';
  panel.refs.reportContent.textContent = t('pae_prepare');
  try {
    await ensureBridgeReady();
    const target = currentBridgeTarget();
    if (!target.adbDevice) throw new Error(t('no_adb_device'));
    paeLog(`Device: ${target.adbDevice}, ESS + pink noise + multitone, ${duration}s ESS`);
    const result = await sendBridgeCommand('pae.start', {
      target, sampleRate: 16000, duration, startHz, endHz, language: lang,
    }, 600000);
    panel.refs.reportContent.className = 'eval-report-content pae-report-content';
    panel.refs.reportContent.style.cssText = '';
    paeState.baseReportHtml = renderEvalMarkdown(result.reportText, result.images || {});
    paeState.metrics = result.metrics || null;
    composePaeReport();
    panel.refs.status.hidden = true;
    panel.refs.exportReport.hidden = false;
    paeLog(`${t('pae_report_ready')}: ${result.reportDir || ''}`);
  } catch (err) {
    const raw = err && err.message ? err.message : String(err);
    if (paeState.cancelRequested || raw.includes('PAE_CANCELLED')) {
      panel.refs.status.textContent = t('pae_cancelled');
      panel.refs.status.style.color = 'var(--muted)';
      panel.refs.reportContent.className = 'eval-report-content pae-report-content eval-placeholder';
      panel.refs.reportContent.style.cssText = 'color:var(--muted);text-align:center;padding:40px 20px';
      panel.refs.reportContent.textContent = t('pae_cancelled');
      return;
    }
    const message = raw.includes('EVAL_TMP_NO_SPACE') ? t('pae_tmp_no_space') : raw;
    panel.refs.status.textContent = message;
    panel.refs.status.hidden = false;
    panel.refs.exportReport.hidden = true;
    panel.refs.status.style.color = 'var(--red)';
    panel.refs.reportContent.className = 'eval-report-content pae-report-content';
    panel.refs.reportContent.style.cssText = 'color:var(--red);text-align:center;padding:40px 20px';
    panel.refs.reportContent.textContent = message;
    paeLog(message, true);
  } finally {
    setPaeRunning(false);
  }
}

function refreshPaeLanguage() {
  if (!paeState.panel) return;
  const refs = paeState.panel.refs;
  refs.title.textContent = t('pae_title');
  refs.projectLabel.textContent = t('pae_project');
  refs.durationLabel.textContent = t('pae_duration');
  refs.startHzLabel.textContent = t('pae_start_hz');
  refs.endHzLabel.textContent = t('pae_end_hz');
  refs.close.textContent = t('close');
  refs.start.textContent = paeState.running ? t('pae_running') : t('pae_start');
  refs.photoButtonText.textContent = t('pae_photos');
  refs.photoStatus.textContent = paeState.photos.length
    ? t('pae_photos_count').replace('{count}', String(paeState.photos.length))
    : t('pae_photos_empty');
  refs.exportReport.textContent = t('pae_export');
  refs.scopeHint.textContent = t('pae_scope_hint');
  updatePaeProjectBar();
  if (refs.reportContent.classList.contains('eval-placeholder'))
    refs.reportContent.textContent = t('pae_ready');
  else composePaeReport();
}
