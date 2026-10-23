// ── device channel settings ──
function clampChannel(value, fallback, min) {
  const n = Number(value);
  const lower = min == null ? 1 : min;
  if (!Number.isFinite(n)) return fallback;
  return Math.max(lower, Math.min(32, Math.floor(n)));
}

function currentUiChannel() {
  return typeof currentChannel === 'string' ? currentChannel : 'tx';
}

function normalizeDeviceSettings(ch) {
  const key = String(ch || 'tx').toLowerCase() === 'rx' ? 'rx' : 'tx';
  const settings = state.deviceSettings[key];
  // Only set default sample rate if not already detected from device
  if (!settings.sampleRate || settings.sampleRate === 16000) {
    settings.sampleRate = 16000;
  }
  if (key === 'rx') {
    settings.inputChannels = clampChannel(settings.inputChannels, 2);
    settings.outputChannels = clampChannel(settings.outputChannels, settings.inputChannels);
    settings.micChannels = settings.inputChannels;
    settings.refChannels = 1;
  } else {
    settings.micChannels = clampChannel(settings.micChannels, 1);
    settings.refChannels = clampChannel(settings.refChannels, 1, 0);
    settings.outputChannels = clampChannel(settings.outputChannels, 1);
    settings.inputChannels = settings.micChannels + settings.refChannels;
  }
  return settings;
}

function onlineChannelConfigFor(ch) {
  const key = String(ch || 'tx').toLowerCase() === 'rx' ? 'rx' : 'tx';
  const settings = normalizeDeviceSettings(key);
  return {
    sampleRate: settings.sampleRate,
    inputChannels: key === 'rx'
      ? settings.inputChannels
      : settings.micChannels + settings.refChannels,
    micChannels: key === 'rx' ? settings.inputChannels : settings.micChannels,
    refChannels: key === 'rx' ? 1 : settings.refChannels,
    outputChannels: settings.outputChannels,
  };
}

function channelSummaryFor(ch) {
  const config = onlineChannelConfigFor(ch);
  return String(ch).toLowerCase() === 'rx'
    ? `${config.inputChannels}/${config.outputChannels}`
    : `${config.micChannels}+${config.refChannels}`;
}

function setDeviceSetting(ch, field, value, min) {
  const key = String(ch || 'tx').toLowerCase() === 'rx' ? 'rx' : 'tx';
  const settings = state.deviceSettings[key];
  settings[field] = clampChannel(value, settings[field], min);
  normalizeDeviceSettings(key);
  refreshDeviceSettingsUi();
}

function syncRxDeviceSettingsFromSource(channels) {
  const settings = state.deviceSettings.rx;
  const count = clampChannel(channels, settings.inputChannels);
  settings.inputChannels = count;
  settings.micChannels = count;
  settings.outputChannels = count;
  normalizeDeviceSettings('rx');
  refreshDeviceSettingsUi();
  return count;
}

function syncDeviceSettingsFromConfig(ch) {
  const key = String(ch || 'tx').toLowerCase() === 'rx' ? 'rx' : 'tx';
  const cfg = state.config[key];
  if (cfg && key === 'tx') {
    const root = cfg.skv_configs;
    if (root) {
      // bf.num_channel = mic channels only (matches Qt semantics)
      const bfNum = (root.bf && root.bf.num_channel) ? Number(root.bf.num_channel) : 0;
      if (bfNum > 0) {
        state.deviceSettings[key].micChannels = bfNum;
        state.deviceSettings[key].inputChannels = state.deviceSettings[key].micChannels + state.deviceSettings[key].refChannels;
      }
    }
  }
  normalizeDeviceSettings(ch);
  refreshDeviceSettingsUi();
}

function deviceSettingInput(ch, field, labelKey, value, min) {
  const m = min != null ? min : 1;
  return `<label class="device-setting">
    <span>${htmlEscape(t(labelKey))}</span>
    <input class="field device-number" type="number" min="${m}" max="32"
      value="${value}" onchange="setDeviceSetting('${ch}','${field}',this.value,${m})">
  </label>`;
}

function deviceSettingsMarkup(ch, compact) {
  const key = String(ch || 'tx').toLowerCase() === 'rx' ? 'rx' : 'tx';
  const settings = normalizeDeviceSettings(key);
  const sample = `<label class="device-setting">
    <span>${htmlEscape(t('sample_rate'))}</span>
    <select class="field device-sample" disabled><option>${settings.sampleRate} Hz</option></select>
  </label>`;
  const title = compact ? t('channel_settings') : t('device_status');
  const sedModel = state.sedModel;
  const sedControl = `<label class="device-setting sed-model-setting">
    <span>${htmlEscape(t('online_sed_model'))}</span>
    <span class="sed-model-actions">
      <button class="btn sm" type="button" onclick="chooseSedModelForTx()">${htmlEscape(t('sed_model_import'))}</button>
      <button class="btn sm" type="button" onclick="useAutoSedModelForTx()">${htmlEscape(t('sed_model_auto'))}</button>
      <button class="btn sm" type="button" onclick="clearSedModelForTx()"${sedModel || state.sedAuto ? '' : ' disabled'}>${htmlEscape(t('sed_model_clear'))}</button>
      <span class="sed-model-name">${htmlEscape(sedModel ? sedModel.name : state.sedAuto ? t('sed_model_auto_active') : t('sed_model_none'))}</span>
    </span>
  </label>`;
  const controls = key === 'rx'
    ? [
        sample,
        deviceSettingInput(key, 'inputChannels', 'input_channels', settings.inputChannels),
        deviceSettingInput(key, 'outputChannels', 'output_channels', settings.outputChannels),
      ]
    : [
        sample,
        deviceSettingInput(key, 'micChannels', 'mic_channels', settings.micChannels),
        deviceSettingInput(key, 'refChannels', 'ref_channels', settings.refChannels, 0),
        deviceSettingInput(key, 'outputChannels', 'output_channels', settings.outputChannels),
        ...(compact ? [] : [sedControl]),
      ];
  return `<div class="device-settings-title">${htmlEscape(title)}</div>
    <div class="device-settings-controls">${controls.join('')}</div>`;
}

function renderDeviceSettingsInto(id, ch, compact) {
  const el = document.getElementById(id);
  if (!el) return;
  el.innerHTML = deviceSettingsMarkup(ch, compact);
}

function refreshDeviceSettingsUi() {
  renderDeviceSettingsInto('mainDeviceSettings', currentUiChannel(), false);
  renderDeviceSettingsInto('onlineDeviceSettings', state.onlineChannel.toLowerCase(), true);
  // Render into param floating window if open
  if (state.paramWindowOpen)
    renderDeviceSettingsInto('paramWindowDeviceSettings', currentUiChannel(), false);
  document.querySelectorAll('[data-online-device-settings]').forEach(el => {
    el.innerHTML = deviceSettingsMarkup(el.dataset.channel || 'tx', true);
  });
  const tx = onlineChannelConfigFor('tx');
  const rx = onlineChannelConfigFor('rx');
  const metCh = document.getElementById('metCh');
  if (metCh) metCh.textContent = currentUiChannel() === 'rx'
    ? `${rx.inputChannels}/${rx.outputChannels}`
    : `${tx.micChannels}+${tx.refChannels}`;
}

function resetRollingStreamShape(ch) {
  const config = onlineChannelConfigFor(ch);
  state.rollingInput.channels = config.inputChannels;
  state.rollingInput.sampleRate = config.sampleRate;
  state.rollingOutput.channels = config.outputChannels;
  state.rollingOutput.sampleRate = config.sampleRate;
}
