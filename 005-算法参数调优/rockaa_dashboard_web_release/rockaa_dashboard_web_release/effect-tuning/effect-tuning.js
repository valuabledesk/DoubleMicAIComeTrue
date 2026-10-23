(function () {
  'use strict';

  const EFFECT_LABELS = {
    zh: {
      title: '音效调试',
      subtitle: 'EQDRC / Loudness / Binary Tuning',
      close: '关闭',
      load: 'Load',
      save: 'Save',
      push: 'Push',
      pull: 'Pull',
      about: 'About',
      open_file: 'Open File',
      spk_response: 'SPK Response',
      total_response: 'Total Response',
      reset: 'Reset',
      set: 'Set',
      global: '基本参数',
      module_switches: '模块使能',
      dataflow: '数据流',
      module_params: '模块参数',
      graph: '曲线',
      log: '日志',
      num_ch: 'NumChan',
      channel: 'Channel',
      sample_rate: 'SampleRate',
      bit_rate: 'BitRate',
      link: 'Link',
      version: 'Version',
      file_name: '文件',
      no_file: '未加载',
      current_channel: '当前通道',
      load_ok: '已加载 bin',
      save_ok: '已生成 bin',
      push_ok: '已推送到设备',
      pull_ok: '已从设备拉取',
      bridge_needed: '需要本地 Native Bridge 和 ADB 设备',
      spk_needed: '请先读取 SPK 频响文件',
      spk_ok: 'SPK 频响已显示',
      total_ok: 'SPK + EQ 总响应已显示',
      reset_ok: '参数已重置',
      set_ok: '参数已更新',
      invalid_drc: '参数错误: noise_threshold < expand_end < compress_start 且 compress_start + max_gain <= max_peak',
      invalid_bin: 'bin 文件长度必须是 4 字节对齐',
      about_text: 'RK Audio Effect Tuning Tool v2.0 HTML\nVersion: 2.0\nDate: 2023-06-15',
    },
    en: {
      title: 'Effect Tuning',
      subtitle: 'EQDRC / Loudness / Binary Tuning',
      close: 'Close',
      load: 'Load',
      save: 'Save',
      push: 'Push',
      pull: 'Pull',
      about: 'About',
      open_file: 'Open File',
      spk_response: 'SPK Response',
      total_response: 'Total Response',
      reset: 'Reset',
      set: 'Set',
      global: 'Basic Settings',
      module_switches: 'Module Enables',
      dataflow: 'Data Flow',
      module_params: 'Module Params',
      graph: 'Graph',
      log: 'Log',
      num_ch: 'NumChan',
      channel: 'Channel',
      sample_rate: 'SampleRate',
      bit_rate: 'BitRate',
      link: 'Link',
      version: 'Version',
      file_name: 'File',
      no_file: 'None',
      current_channel: 'Channel',
      load_ok: 'Loaded bin',
      save_ok: 'Generated bin',
      push_ok: 'Pushed to device',
      pull_ok: 'Pulled from device',
      bridge_needed: 'Local Native Bridge and ADB device are required',
      spk_needed: 'Load an SPK response file first',
      spk_ok: 'SPK response shown',
      total_ok: 'SPK + EQ response shown',
      reset_ok: 'Params reset',
      set_ok: 'Params updated',
      invalid_drc: 'Invalid params: noise_threshold < expand_end < compress_start and compress_start + max_gain <= max_peak',
      invalid_bin: 'bin file must be 4-byte aligned',
      about_text: 'RK Audio Effect Tuning Tool v2.0 HTML\nVersion: 2.0\nDate: 2023-06-15',
    },
  };

  const SAMPLE_RATES = [96000, 88200, 48000, 44100, 32000, 24000, 16000, 12000, 8000];
  const BIT_RATES = [16, 24, 32];
  const MODULES = ['spk', 'autogain', 'nolinear', 'eq', 'mbdrc', 'maximizer'];
  const MODULE_TITLES = {
    spk: 'SPK',
    autogain: 'AUTOGAIN',
    nolinear: 'NOLINEAR',
    eq: 'EQ',
    mbdrc: 'MBDRC',
    maximizer: 'MAXIMIZER',
  };
  const FILTER_TYPES = ['Parametric', 'LowShelf', 'HighShelf', 'GeneralLP', 'GeneralHP'];
  const MBDRC_BANDS = ['Low Frequency', 'Mid Frequency 1', 'Mid Frequency 2', 'High Frequency'];
  const BIN_INDEX = {
    total: 0,
    spk: 20,
    autogain: 30,
    bass: 60,
    exciter: 80,
    deesser: 90,
    eq: 100,
    mbdrc: 200,
    maximizer: 400,
  };

  const state = {
    visible: false,
    currentChannel: 0,
    currentModule: 'spk',
    selectedMbdrc: 0,
    activePlot: 'spk',
    global: null,
    channels: [],
    wired: false,
    log: [],
  };

  function label(key) {
    const table = EFFECT_LABELS[typeof lang === 'string' && lang === 'en' ? 'en' : 'zh'];
    return table[key] || key;
  }

  function clone(value) {
    return JSON.parse(JSON.stringify(value));
  }

  function number(value, fallback) {
    const n = Number(value);
    return Number.isFinite(n) ? n : fallback;
  }

  function intValue(value, fallback) {
    const n = parseInt(value, 10);
    return Number.isFinite(n) ? n : fallback;
  }

  function fmt(value) {
    if (!Number.isFinite(Number(value))) return String(value ?? '');
    const n = Number(value);
    if (Math.abs(n - Math.round(n)) < 1e-6) return String(Math.round(n));
    return String(Math.round(n * 1000000) / 1000000);
  }

  function esc(text) {
    if (typeof htmlEscape === 'function') return htmlEscape(text);
    return String(text).replace(/[&<>"']/g, ch => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    }[ch]));
  }

  function defaultGlobal() {
    return {
      numCh: 2,
      sampleRate: 48000,
      bitRate: 16,
      link: 0,
      toolVersion: 2.0,
      userVersion: '0.0.0',
      switches: {
        autogain: 0,
        bass: 0,
        exciter: 0,
        deesser: 1,
        eq10: 1,
        mbdrc: 0,
        agc: 1,
        maximizer: 1,
      },
    };
  }

  function defaultEqFilters() {
    const types = [1, 0, 0, 0, 0, 0, 0, 0, 0, 2];
    const fcs = [100, 200, 500, 1000, 1500, 2000, 4000, 8000, 10000, 20000];
    const qs = [1, 2, 2, 2, 2, 2, 2, 2, 2, 1];
    const boosts = [5, 0, 0, 3, 0, 0, 0, 0, 0, 0];
    return types.map((filterType, i) => ({
      enable: 0,
      filterType,
      fc: fcs[i],
      Q: qs[i],
      boost: boosts[i],
    }));
  }

  function defaultDrcBand(index) {
    const starts = [0, 250, 1000, 3000];
    const ends = [250, 1000, 3000, 24000];
    return {
      freq_start: starts[index] || 0,
      freq_end: ends[index] || 24000,
      gain_dB: 0,
      drc_enable: 1,
      compress_start: -20,
      expand_end: -40,
      noise_threshold: -45,
      max_gain: 16,
      max_peak: -1,
      attack_time: 200,
      release_time: 400,
      hold_time: 200,
    };
  }

  function defaultChannel() {
    return {
      spk: {
        preGain: 0,
        fileName: '',
        fileText: '',
        response: { x: [], y: [], z: [] },
      },
      autogain: {
        target_i_dB: -18,
        attack_time: 400,
        release_time: 200,
        r128Wins: 400,
        r128Steps: 100,
      },
      nolinear: {
        bass: {
          amount_dB: 0,
          drive: 8.5,
          blend: 0,
          freq: 100,
          floor_active: 0,
          floor_freq: 20,
        },
        exciter: {
          even_harmonics: 0.2,
          distortion_amount: 0.2,
          cutoff: 4000,
          mix: 0.5,
        },
        deesser: {
          f0: 3500,
          threshold: -23,
        },
      },
      eq: {
        filters: defaultEqFilters(),
      },
      mbdrc: {
        crossBand: 2,
        bands: [0, 1, 2, 3].map(defaultDrcBand),
      },
      maximizer: {
        maximizer: {
          max_threshold: -3,
          ceiling: -1,
          release: 1,
        },
        agc: {
          compress_start: -20,
          expand_end: -40,
          noise_threshold: -45,
          max_gain: 16,
          max_peak: -1,
          attack_time: 200,
          release_time: 400,
          hold_time: 200,
        },
      },
    };
  }

  function resetAll() {
    state.global = defaultGlobal();
    state.channels = [defaultChannel(), defaultChannel()];
    state.currentChannel = 0;
    state.currentModule = 'spk';
    state.selectedMbdrc = 0;
    state.activePlot = 'spk';
    state.log = [];
  }

  resetAll();

  function currentChannel() {
    return state.channels[state.currentChannel];
  }

  function logLine(message) {
    const ts = new Date().toLocaleTimeString();
    state.log.push(`[${ts}] ${message}`);
    if (state.log.length > 200) state.log.shift();
    const el = document.querySelector('#effectShell .effect-log');
    if (el) {
      el.textContent = state.log.join('\n');
      el.scrollTop = el.scrollHeight;
    }
    if (typeof log === 'function' && !state.visible) log('[Effect] ' + message);
  }

  function getPath(root, path) {
    return path.reduce((obj, key) => obj && obj[key], root);
  }

  function setPath(root, path, value) {
    let obj = root;
    for (let i = 0; i < path.length - 1; i++) obj = obj[path[i]];
    obj[path[path.length - 1]] = value;
  }

  function inputField(path, value, options) {
    const opts = options || {};
    const cls = opts.compact ? 'effect-input compact' : 'effect-input';
    const type = opts.type || 'number';
    const step = opts.step || (Number.isInteger(Number(value)) ? '1' : '0.01');
    return `<label class="effect-field">
      <span>${esc(opts.label || path[path.length - 1])}</span>
      <input class="${cls}" type="${type}" step="${step}" value="${esc(fmt(value))}" data-effect-path="${esc(path.join('.'))}">
    </label>`;
  }

  function checkboxField(path, value, text) {
    return `<label class="effect-check">
      <input type="checkbox" ${Number(value) ? 'checked' : ''} data-effect-path="${esc(path.join('.'))}">
      <span>${esc(text || path[path.length - 1])}</span>
    </label>`;
  }

  function selectField(path, value, values, options) {
    const opts = options || {};
    return `<label class="effect-field">
      <span>${esc(opts.label || path[path.length - 1])}</span>
      <select class="effect-input" data-effect-path="${esc(path.join('.'))}">
        ${values.map(item => {
          const itemValue = Array.isArray(item) ? item[0] : item;
          const text = Array.isArray(item) ? item[1] : item;
          return `<option value="${esc(itemValue)}" ${String(itemValue) === String(value) ? 'selected' : ''}>${esc(text)}</option>`;
        }).join('')}
      </select>
    </label>`;
  }

  function button(action, text, extraClass) {
    return `<button class="btn sm ${extraClass || ''}" type="button" data-effect-action="${esc(action)}">${esc(text)}</button>`;
  }

  function renderGlobalControls() {
    const g = state.global;
    const switchKeys = [
      ['autogain', 'autogain_enable'],
      ['bass', 'bass_enable'],
      ['exciter', 'exciter_enable'],
      ['deesser', 'deesser_enable'],
      ['eq10', 'eq10_enable'],
      ['mbdrc', 'mbdrc_enable'],
      ['agc', 'agc_enable'],
      ['maximizer', 'maximizer_enable'],
    ];
    return `<div class="panel effect-global-panel">
      <div class="panel-head"><span>${esc(label('global'))}</span><span class="badge">${esc(label('current_channel'))}: ch${state.currentChannel + 1}</span></div>
      <div class="effect-global-grid">
        ${selectField(['global', 'numCh'], g.numCh, [1, 2], { label: label('num_ch') })}
        <label class="effect-field"><span>${esc(label('channel'))}</span>
          <select class="effect-input" data-effect-channel>
            <option value="0" ${state.currentChannel === 0 ? 'selected' : ''}>ch1</option>
            <option value="1" ${state.currentChannel === 1 ? 'selected' : ''}>ch2</option>
          </select>
        </label>
        ${selectField(['global', 'sampleRate'], g.sampleRate, SAMPLE_RATES, { label: label('sample_rate') })}
        ${selectField(['global', 'bitRate'], g.bitRate, BIT_RATES, { label: label('bit_rate') })}
        ${selectField(['global', 'link'], g.link, [[0, 'no'], [1, 'yes']], { label: label('link') })}
        <label class="effect-field"><span>${esc(label('version'))}</span>
          <input class="effect-input" type="text" value="${esc(g.userVersion)}" data-effect-version>
        </label>
      </div>
      <div class="effect-switch-grid">
        <div class="effect-section-title">${esc(label('module_switches'))}</div>
        ${switchKeys.map(([key, text]) => checkboxField(['global', 'switches', key], g.switches[key], text)).join('')}
      </div>
    </div>`;
  }

  function renderFlow() {
    return `<div class="panel effect-flow-panel">
      <div class="panel-head"><span>${esc(label('dataflow'))}</span><span class="badge">Input -> PreGain -> Modules -> Output</span></div>
      <div class="effect-flow">
        <span class="effect-flow-node">Input</span>
        <span class="effect-flow-arrow">-></span>
        <span class="effect-flow-node">PreGain</span>
        <span class="effect-flow-arrow">-></span>
        ${MODULES.map(module => `<button class="effect-module-btn ${state.currentModule === module ? 'active' : ''}" type="button" data-effect-module="${module}">${MODULE_TITLES[module]}</button>`).join('<span class="effect-flow-arrow">-></span>')}
        <span class="effect-flow-arrow">-></span>
        <span class="effect-flow-node">Output</span>
      </div>
    </div>`;
  }

  function renderSpk(ch) {
    const spk = ch.spk;
    return `<div class="effect-module-layout">
      <div class="panel">
        <div class="panel-head"><span>SPK</span><span class="badge">channel${state.currentChannel + 1}</span></div>
        <div class="effect-card-body">
          ${inputField(['channels', state.currentChannel, 'spk', 'preGain'], spk.preGain, { label: 'PreGain' })}
          <div class="effect-file-row"><span>${esc(label('file_name'))}: ${esc(spk.fileName || label('no_file'))}</span></div>
          <div class="effect-button-row">
            ${button('open-spk', label('open_file'))}
            ${button('spk-response', label('spk_response'))}
            ${button('total-response', label('total_response'))}
          </div>
        </div>
      </div>
      ${renderGraphPanel('effectGraph', 'SPK Response')}
    </div>`;
  }

  function renderAutoGain(ch) {
    const a = ch.autogain;
    return `<div class="effect-module-layout">
      <div class="panel">
        <div class="panel-head"><span>AUTOGAIN</span>${button('reset-module', label('reset'))}</div>
        <div class="effect-card-body effect-fields-two">
          ${inputField(['channels', state.currentChannel, 'autogain', 'target_i_dB'], a.target_i_dB)}
          ${inputField(['channels', state.currentChannel, 'autogain', 'attack_time'], a.attack_time)}
          ${inputField(['channels', state.currentChannel, 'autogain', 'release_time'], a.release_time)}
          ${inputField(['channels', state.currentChannel, 'autogain', 'r128Wins'], a.r128Wins)}
          ${inputField(['channels', state.currentChannel, 'autogain', 'r128Steps'], a.r128Steps)}
        </div>
      </div>
      ${renderInfoPanel('AUTOGAIN', ['target_i_dB', 'attack_time', 'release_time', 'r128Wins', 'r128Steps'])}
    </div>`;
  }

  function renderNonLinear(ch) {
    const n = ch.nolinear;
    return `<div class="effect-module-layout wide">
      <div class="panel">
        <div class="panel-head"><span>NOLINEAR</span>${button('reset-module', label('reset'))}</div>
        <div class="effect-three-col">
          ${renderFieldCard('Bass Enhancer', [
            inputField(['channels', state.currentChannel, 'nolinear', 'bass', 'amount_dB'], n.bass.amount_dB),
            inputField(['channels', state.currentChannel, 'nolinear', 'bass', 'drive'], n.bass.drive),
            inputField(['channels', state.currentChannel, 'nolinear', 'bass', 'blend'], n.bass.blend),
            inputField(['channels', state.currentChannel, 'nolinear', 'bass', 'freq'], n.bass.freq),
            checkboxField(['channels', state.currentChannel, 'nolinear', 'bass', 'floor_active'], n.bass.floor_active, 'floor_active'),
            inputField(['channels', state.currentChannel, 'nolinear', 'bass', 'floor_freq'], n.bass.floor_freq),
          ])}
          ${renderFieldCard('Exciter', [
            inputField(['channels', state.currentChannel, 'nolinear', 'exciter', 'even_harmonics'], n.exciter.even_harmonics),
            inputField(['channels', state.currentChannel, 'nolinear', 'exciter', 'distortion_amount'], n.exciter.distortion_amount),
            inputField(['channels', state.currentChannel, 'nolinear', 'exciter', 'cutoff'], n.exciter.cutoff),
            inputField(['channels', state.currentChannel, 'nolinear', 'exciter', 'mix'], n.exciter.mix),
          ])}
          ${renderFieldCard('Deesser', [
            inputField(['channels', state.currentChannel, 'nolinear', 'deesser', 'f0'], n.deesser.f0),
            inputField(['channels', state.currentChannel, 'nolinear', 'deesser', 'threshold'], n.deesser.threshold),
          ])}
        </div>
      </div>
    </div>`;
  }

  function renderEq(ch) {
    const rows = ch.eq.filters.map((filter, index) => `<tr>
      <td>${index + 1}</td>
      <td><input type="checkbox" ${filter.enable ? 'checked' : ''} data-effect-path="channels.${state.currentChannel}.eq.filters.${index}.enable"></td>
      <td><select class="effect-input compact" data-effect-path="channels.${state.currentChannel}.eq.filters.${index}.filterType">
        ${FILTER_TYPES.map((name, typeIndex) => `<option value="${typeIndex}" ${typeIndex === Number(filter.filterType) ? 'selected' : ''}>${name}</option>`).join('')}
      </select></td>
      <td><input class="effect-input compact" type="number" step="1" value="${esc(fmt(filter.fc))}" data-effect-path="channels.${state.currentChannel}.eq.filters.${index}.fc"></td>
      <td><input class="effect-input compact" type="number" step="0.01" value="${esc(fmt(filter.Q))}" data-effect-path="channels.${state.currentChannel}.eq.filters.${index}.Q"></td>
      <td><input class="effect-input compact" type="number" step="0.1" value="${esc(fmt(filter.boost))}" data-effect-path="channels.${state.currentChannel}.eq.filters.${index}.boost"></td>
    </tr>`).join('');
    return `<div class="effect-module-layout">
      <div class="panel">
        <div class="panel-head"><span>EQ</span><span>${button('reset-module', label('reset'))}${button('set-module', label('set'), 'primary')}</span></div>
        <div class="effect-table-wrap">
          <table class="effect-table">
            <thead><tr><th>#</th><th>Enable</th><th>filter</th><th>fc</th><th>Q</th><th>boost</th></tr></thead>
            <tbody>${rows}</tbody>
          </table>
        </div>
      </div>
      ${renderGraphPanel('effectGraph', 'EQ Response')}
    </div>`;
  }

  function renderMbdrc(ch) {
    const m = ch.mbdrc;
    return `<div class="effect-module-layout">
      <div class="panel">
        <div class="panel-head"><span>MBDRC</span><span>${button('reset-module', label('reset'))}${button('set-module', label('set'), 'primary')}</span></div>
        <div class="effect-card-body">
          <div class="effect-toolbar-line">
            ${selectField(['channels', state.currentChannel, 'mbdrc', 'crossBand'], m.crossBand, [2, 3, 4], { label: 'Cross Band' })}
            <label class="effect-field"><span>DRC</span>
              <select class="effect-input" data-effect-mbdrc-select>
                ${MBDRC_BANDS.map((name, i) => `<option value="${i}" ${i === state.selectedMbdrc ? 'selected' : ''}>${esc(name)}</option>`).join('')}
              </select>
            </label>
          </div>
          <div class="effect-band-grid">
            ${m.bands.map((band, i) => renderDrcBand(i, band)).join('')}
          </div>
        </div>
      </div>
      ${renderGraphPanel('effectGraph', MBDRC_BANDS[state.selectedMbdrc])}
    </div>`;
  }

  function renderDrcBand(index, band) {
    const prefix = ['channels', state.currentChannel, 'mbdrc', 'bands', index];
    return `<div class="effect-mini-card ${index === state.selectedMbdrc ? 'active' : ''}">
      <div class="effect-mini-title">${esc(MBDRC_BANDS[index])}</div>
      ${inputField(prefix.concat('freq_start'), band.freq_start, { compact: true })}
      ${inputField(prefix.concat('freq_end'), band.freq_end, { compact: true })}
      ${inputField(prefix.concat('gain_dB'), band.gain_dB, { compact: true })}
      ${checkboxField(prefix.concat('drc_enable'), band.drc_enable, 'drc_enable')}
      ${inputField(prefix.concat('compress_start'), band.compress_start, { compact: true })}
      ${inputField(prefix.concat('expand_end'), band.expand_end, { compact: true })}
      ${inputField(prefix.concat('noise_threshold'), band.noise_threshold, { compact: true })}
      ${inputField(prefix.concat('max_gain'), band.max_gain, { compact: true })}
      ${inputField(prefix.concat('max_peak'), band.max_peak, { compact: true })}
      ${inputField(prefix.concat('attack_time'), band.attack_time, { compact: true })}
      ${inputField(prefix.concat('release_time'), band.release_time, { compact: true })}
      ${inputField(prefix.concat('hold_time'), band.hold_time, { compact: true })}
    </div>`;
  }

  function renderMaximizer(ch) {
    const m = ch.maximizer;
    return `<div class="effect-module-layout">
      <div class="panel">
        <div class="panel-head"><span>MAXIMIZER</span><span>${button('reset-module', label('reset'))}${button('set-module', label('set'), 'primary')}</span></div>
        <div class="effect-two-col">
          ${renderFieldCard('AGC', [
            inputField(['channels', state.currentChannel, 'maximizer', 'agc', 'compress_start'], m.agc.compress_start),
            inputField(['channels', state.currentChannel, 'maximizer', 'agc', 'expand_end'], m.agc.expand_end),
            inputField(['channels', state.currentChannel, 'maximizer', 'agc', 'noise_threshold'], m.agc.noise_threshold),
            inputField(['channels', state.currentChannel, 'maximizer', 'agc', 'max_gain'], m.agc.max_gain),
            inputField(['channels', state.currentChannel, 'maximizer', 'agc', 'max_peak'], m.agc.max_peak),
            inputField(['channels', state.currentChannel, 'maximizer', 'agc', 'attack_time'], m.agc.attack_time),
            inputField(['channels', state.currentChannel, 'maximizer', 'agc', 'release_time'], m.agc.release_time),
            inputField(['channels', state.currentChannel, 'maximizer', 'agc', 'hold_time'], m.agc.hold_time),
          ])}
          ${renderFieldCard('Maximizer', [
            inputField(['channels', state.currentChannel, 'maximizer', 'maximizer', 'max_threshold'], m.maximizer.max_threshold),
            inputField(['channels', state.currentChannel, 'maximizer', 'maximizer', 'ceiling'], m.maximizer.ceiling),
            inputField(['channels', state.currentChannel, 'maximizer', 'maximizer', 'release'], m.maximizer.release),
          ])}
        </div>
      </div>
      <div class="panel effect-graph-stack">
        <div class="panel-head"><span>${esc(label('graph'))}</span></div>
        <canvas id="effectAgcGraph" height="210"></canvas>
        <canvas id="effectMaxGraph" height="210"></canvas>
      </div>
    </div>`;
  }

  function renderFieldCard(title, fields) {
    return `<div class="effect-mini-card"><div class="effect-mini-title">${esc(title)}</div>${fields.join('')}</div>`;
  }

  function renderGraphPanel(id, title) {
    return `<div class="panel effect-graph-panel">
      <div class="panel-head"><span>${esc(label('graph'))}</span><span class="badge">${esc(title || '')}</span></div>
      <canvas id="${esc(id)}"></canvas>
    </div>`;
  }

  function renderInfoPanel(title, items) {
    return `<div class="panel effect-info-panel">
      <div class="panel-head"><span>${esc(title)}</span></div>
      <div class="effect-info-list">${items.map(item => `<span class="badge">${esc(item)}</span>`).join('')}</div>
    </div>`;
  }

  function renderModule() {
    const ch = currentChannel();
    if (state.currentModule === 'spk') return renderSpk(ch);
    if (state.currentModule === 'autogain') return renderAutoGain(ch);
    if (state.currentModule === 'nolinear') return renderNonLinear(ch);
    if (state.currentModule === 'eq') return renderEq(ch);
    if (state.currentModule === 'mbdrc') return renderMbdrc(ch);
    return renderMaximizer(ch);
  }

  function render() {
    const shell = document.getElementById('effectShell');
    const root = document.getElementById('effectTuningRoot');
    if (!shell || !root) return;
    const title = shell.querySelector('[data-effect-title]');
    const crumb = shell.querySelector('[data-effect-subtitle]');
    const closeBtn = shell.querySelector('[data-effect-close]');
    if (title) title.textContent = label('title');
    if (crumb) crumb.textContent = label('subtitle');
    if (closeBtn) closeBtn.textContent = label('close');
    root.innerHTML = `
      <div class="effect-toolbar panel">
        ${button('load-bin', label('load'))}
        ${button('save-bin', label('save'), 'primary')}
        ${button('push-bin', label('push'))}
        ${button('pull-bin', label('pull'))}
        <span style="flex:1"></span>
        <span class="badge">${esc(effectBinName())}</span>
        ${button('about', label('about'))}
      </div>
      ${renderGlobalControls()}
      ${renderFlow()}
      <div class="effect-main-grid">
        <div class="effect-module-host">${renderModule()}</div>
        <div class="panel effect-log-panel">
          <div class="panel-head"><span>${esc(label('log'))}</span></div>
          <pre class="effect-log">${esc(state.log.join('\n'))}</pre>
        </div>
      </div>`;
    requestAnimationFrame(drawCurrentModule);
  }

  function openPage() {
    const main = document.getElementById('mainShell');
    const autotune = document.getElementById('autotuneShell');
    const shell = document.getElementById('effectShell');
    if (!shell) return;
    if (typeof closeAutotuneDialog === 'function') closeAutotuneDialog();
    if (autotune) autotune.hidden = true;
    if (main) main.hidden = true;
    shell.hidden = false;
    state.visible = true;
    wire();
    setActiveNav();
    render();
  }

  function closePage() {
    const main = document.getElementById('mainShell');
    const shell = document.getElementById('effectShell');
    if (shell) shell.hidden = true;
    if (main) main.hidden = false;
    state.visible = false;
    const nav = document.querySelector('.nav-item[data-page="effect-tuning"]');
    if (nav) nav.classList.remove('active');
    if (!document.querySelector('.nav-item.active[data-page]')) {
      const tuning = document.querySelector('.nav-item[data-page="tuning"]');
      if (tuning) tuning.classList.add('active');
    }
  }

  function setActiveNav() {
    document.querySelectorAll('.nav-item').forEach(n => n.classList.remove('active'));
    const nav = document.querySelector('.nav-item[data-page="effect-tuning"]');
    if (nav) nav.classList.add('active');
  }

  function wire() {
    const shell = document.getElementById('effectShell');
    if (!shell || state.wired) return;
    state.wired = true;
    const closeBtn = shell.querySelector('[data-effect-close]');
    if (closeBtn) closeBtn.addEventListener('click', closePage);
    shell.addEventListener('click', onClick);
    shell.addEventListener('input', onInput);
    shell.addEventListener('change', onInput);
    window.addEventListener('resize', () => {
      if (state.visible) drawCurrentModule();
    });
  }

  function onClick(ev) {
    const moduleBtn = ev.target.closest('[data-effect-module]');
    if (moduleBtn) {
      state.currentModule = moduleBtn.dataset.effectModule;
      render();
      return;
    }
    const actionBtn = ev.target.closest('[data-effect-action]');
    if (!actionBtn) return;
    const action = actionBtn.dataset.effectAction;
    if (action === 'load-bin') chooseBinFile();
    else if (action === 'save-bin') saveBin();
    else if (action === 'push-bin') pushBin();
    else if (action === 'pull-bin') pullBin();
    else if (action === 'about') alert(label('about_text'));
    else if (action === 'open-spk') chooseSpkFile();
    else if (action === 'spk-response') showSpkResponse();
    else if (action === 'total-response') showTotalResponse();
    else if (action === 'reset-module') resetModule();
    else if (action === 'set-module') setModule();
  }

  function onInput(ev) {
    const channelSelect = ev.target.closest('[data-effect-channel]');
    if (channelSelect) {
      state.currentChannel = intValue(channelSelect.value, 0) === 1 ? 1 : 0;
      render();
      return;
    }
    const version = ev.target.closest('[data-effect-version]');
    if (version) {
      state.global.userVersion = sanitizeVersion(version.value, ev.type === 'change');
      if (ev.type === 'change') {
        version.value = state.global.userVersion;
        render();
      }
      return;
    }
    const mbdrcSelect = ev.target.closest('[data-effect-mbdrc-select]');
    if (mbdrcSelect) {
      state.selectedMbdrc = intValue(mbdrcSelect.value, 0);
      drawCurrentModule();
      render();
      return;
    }
    const pathText = ev.target.dataset ? ev.target.dataset.effectPath : '';
    if (!pathText) return;
    const path = pathText.split('.').map(part => /^\d+$/.test(part) ? Number(part) : part);
    let value = ev.target.type === 'checkbox' ? (ev.target.checked ? 1 : 0) : ev.target.value;
    if (ev.target.tagName === 'SELECT' || ev.target.type === 'number') value = number(value, getPath(state, path));
    setPath(state, path, value);
    if (path.join('.') === 'global.sampleRate') {
      state.global.sampleRate = intValue(value, 48000);
    }
    drawCurrentModule();
  }

  function sanitizeVersion(text, strict) {
    const parts = String(text || '').split('.').filter(part => /^\d+$/.test(part)).slice(0, 3);
    if (!strict) return String(text || '');
    while (parts.length < 3) parts.push('0');
    return parts.length ? parts.join('.') : '0.0.0';
  }

  function resetModule() {
    const ch = currentChannel();
    const fresh = defaultChannel();
    if (state.currentModule === 'spk') ch.spk = fresh.spk;
    else if (state.currentModule === 'autogain') ch.autogain = fresh.autogain;
    else if (state.currentModule === 'nolinear') ch.nolinear = fresh.nolinear;
    else if (state.currentModule === 'eq') ch.eq = fresh.eq;
    else if (state.currentModule === 'mbdrc') ch.mbdrc = fresh.mbdrc;
    else if (state.currentModule === 'maximizer') ch.maximizer = fresh.maximizer;
    logLine(`${MODULE_TITLES[state.currentModule]}: ${label('reset_ok')}`);
    render();
  }

  function setModule() {
    const errors = validateCurrentModule();
    if (errors.length) {
      logLine(errors.join('; '));
      alert(errors.join('\n'));
      return;
    }
    logLine(`${MODULE_TITLES[state.currentModule]}: ${label('set_ok')}`);
    drawCurrentModule();
  }

  function validateCurrentModule() {
    const errors = [];
    const checkDrc = drc => {
      if (number(drc.noise_threshold, 0) > number(drc.expand_end, 0)
          || number(drc.expand_end, 0) > number(drc.compress_start, 0)
          || number(drc.compress_start, 0) + number(drc.max_gain, 0) > number(drc.max_peak, 0)) {
        errors.push(label('invalid_drc'));
      }
    };
    const ch = currentChannel();
    if (state.currentModule === 'mbdrc') ch.mbdrc.bands.forEach(checkDrc);
    if (state.currentModule === 'maximizer') checkDrc(ch.maximizer.agc);
    return [...new Set(errors)];
  }

  function parseSpkText(text) {
    const x = [];
    const y = [];
    const z = [];
    String(text || '').split(/\r?\n/).forEach((line, index) => {
      const parts = line.split(',').map(part => part.trim());
      if (index > 1 && parts.length === 3) {
        const fx = Number(parts[0]);
        const fy = Number(parts[1]);
        const fz = Number(parts[2]);
        if (Number.isFinite(fx) && Number.isFinite(fy) && Number.isFinite(fz)) {
          x.push(fx);
          y.push(fy);
          z.push(fz);
        }
      }
    });
    return { x, y, z };
  }

  function chooseSpkFile() {
    const input = document.getElementById('fileEffectSpk');
    if (!input) return;
    input.onchange = () => {
      const file = input.files && input.files[0];
      if (!file) return;
      const reader = new FileReader();
      reader.onload = e => {
        const ch = currentChannel();
        ch.spk.fileName = file.name;
        ch.spk.fileText = String(e.target.result || '');
        ch.spk.response = parseSpkText(ch.spk.fileText);
        state.activePlot = 'spk';
        logLine(`${label('open_file')}: ${file.name}`);
        render();
      };
      reader.readAsText(file);
      input.value = '';
    };
    input.click();
  }

  function showSpkResponse() {
    const response = currentChannel().spk.response;
    if (!response.x.length) {
      alert(label('spk_needed'));
      logLine(label('spk_needed'));
      return;
    }
    state.activePlot = 'spk';
    drawCurrentModule();
    logLine(label('spk_ok'));
  }

  function showTotalResponse() {
    const response = currentChannel().spk.response;
    if (!response.x.length) {
      alert(label('spk_needed'));
      logLine(label('spk_needed'));
      return;
    }
    state.activePlot = 'total';
    drawCurrentModule();
    logLine(label('total_ok'));
  }

  function biquadCoefficients(filter, fs) {
    let filterType = intValue(filter.filterType, 0);
    let fc = clamp(number(filter.fc, 0), 0, fs / 2);
    let q = number(filter.Q, 1);
    const boost = clamp(number(filter.boost, 0), -20, 20);
    if (filterType > 0 && filterType < 3) q = clamp(q, 0.01, 2);
    else q = clamp(q, 0.01, 16);
    filter.fc = fc;
    filter.Q = q;
    filter.boost = boost;

    const A = Math.pow(10, boost / 40);
    const w0 = 2 * Math.PI * fc / fs;
    let a0 = 1;
    let a1 = 0;
    let a2 = 0;
    let b0 = 0;
    let b1 = 0;
    let b2 = 0;

    if (filterType === 0) {
      const alpha = Math.sin(w0) / (2 * q);
      a0 = 1 + alpha / A;
      a1 = -2 * Math.cos(w0);
      a2 = 1 - alpha / A;
      b0 = 1 + alpha * A;
      b1 = -2 * Math.cos(w0);
      b2 = 1 - alpha * A;
    } else if (filterType === 1) {
      const alpha = Math.sin(w0) / 2 * Math.sqrt((A + 1 / A) * (1 / (q + 1e-8) - 1) + 2);
      a0 = (A + 1) + (A - 1) * Math.cos(w0) + 2 * Math.sqrt(A) * alpha;
      a1 = -2 * ((A - 1) + (A + 1) * Math.cos(w0));
      a2 = (A + 1) + (A - 1) * Math.cos(w0) - 2 * Math.sqrt(A) * alpha;
      b0 = A * ((A + 1) - (A - 1) * Math.cos(w0) + 2 * Math.sqrt(A) * alpha);
      b1 = 2 * A * ((A - 1) - (A + 1) * Math.cos(w0));
      b2 = A * ((A + 1) - (A - 1) * Math.cos(w0) - 2 * Math.sqrt(A) * alpha);
    } else if (filterType === 2) {
      const alpha = Math.sin(w0) / 2 * Math.sqrt((A + 1 / A) * (1 / (q + 1e-8) - 1) + 2);
      a0 = (A + 1) - (A - 1) * Math.cos(w0) + 2 * Math.sqrt(A) * alpha;
      a1 = 2 * ((A - 1) - (A + 1) * Math.cos(w0));
      a2 = (A + 1) - (A - 1) * Math.cos(w0) - 2 * Math.sqrt(A) * alpha;
      b0 = A * ((A + 1) + (A - 1) * Math.cos(w0) + 2 * Math.sqrt(A) * alpha);
      b1 = -2 * A * ((A - 1) + (A + 1) * Math.cos(w0));
      b2 = A * ((A + 1) + (A - 1) * Math.cos(w0) - 2 * Math.sqrt(A) * alpha);
    } else if (filterType === 3) {
      const alpha = Math.sin(w0) / (2 * q);
      a0 = 1 + alpha;
      a1 = -2 * Math.cos(w0);
      a2 = 1 - alpha;
      b0 = 0.5 * (1 - Math.cos(w0)) * A;
      b1 = (1 - Math.cos(w0)) * A;
      b2 = 0.5 * (1 - Math.cos(w0)) * A;
    } else {
      const alpha = Math.sin(w0) / (2 * q);
      a0 = 1 + alpha;
      a1 = -2 * Math.cos(w0);
      a2 = 1 - alpha;
      b0 = 0.5 * (1 + Math.cos(w0)) * A;
      b1 = -(1 + Math.cos(w0)) * A;
      b2 = 0.5 * (1 + Math.cos(w0)) * A;
    }

    return {
      b: [b0 / a0, b1 / a0, b2 / a0],
      a: [1, a1 / a0, a2 / a0],
    };
  }

  function complexBiquadMag(coef, w) {
    const c1 = Math.cos(w);
    const s1 = -Math.sin(w);
    const c2 = Math.cos(2 * w);
    const s2 = -Math.sin(2 * w);
    const nr = coef.b[0] + coef.b[1] * c1 + coef.b[2] * c2;
    const ni = coef.b[1] * s1 + coef.b[2] * s2;
    const dr = 1 + coef.a[1] * c1 + coef.a[2] * c2;
    const di = coef.a[1] * s1 + coef.a[2] * s2;
    return Math.sqrt((nr * nr + ni * ni) / Math.max(1e-20, dr * dr + di * di));
  }

  function eqResponse(ch) {
    const fs = intValue(state.global.sampleRate, 48000);
    const nfft = Math.max(64, Math.floor(fs / 20));
    const freqs = [];
    const db = [];
    const coefs = ch.eq.filters.map(filter => biquadCoefficients(filter, fs));
    for (let i = 0; i < nfft; i++) {
      const w = Math.PI * i / nfft;
      const freq = w / Math.PI * fs / 2;
      let mag = 1;
      ch.eq.filters.forEach((filter, idx) => {
        if (Number(filter.enable) === 1) mag *= complexBiquadMag(coefs[idx], w);
      });
      freqs.push(freq);
      db.push(20 * Math.log10(Math.max(1e-8, mag)));
    }
    return { x: freqs, y: db };
  }

  function interpolate(xs, ys, x) {
    if (!xs.length) return 0;
    if (x <= xs[0]) return 0;
    if (x >= xs[xs.length - 1]) return 0;
    for (let i = 1; i < xs.length; i++) {
      if (x <= xs[i]) {
        const x0 = xs[i - 1];
        const x1 = xs[i];
        const t0 = ys[i - 1];
        const t1 = ys[i];
        const ratio = (x - x0) / Math.max(1e-12, x1 - x0);
        return t0 + (t1 - t0) * ratio;
      }
    }
    return 0;
  }

  function drcCurve(drc) {
    const KNEE_WIDTH = 6;
    const maxPeak = number(drc.max_peak, -1);
    const compressStart = number(drc.compress_start, -20);
    const noiseThreshold = number(drc.noise_threshold, -45);
    const expandEnd = number(drc.expand_end, -40);
    const maxGain = number(drc.max_gain, 16);
    const compressRate = -(maxPeak - (compressStart + maxGain)) / compressStart;
    const expandRate = (expandEnd + maxGain - noiseThreshold) / (expandEnd - noiseThreshold);
    const x = [];
    const y = [];
    for (let i = -1000; i <= 0; i++) {
      const value = i * 0.1;
      let out = value;
      if (value <= noiseThreshold) {
        out = noiseThreshold + (value - noiseThreshold) * expandRate;
      } else if (value <= expandEnd - 0.5 * KNEE_WIDTH) {
        out = noiseThreshold + (value - noiseThreshold) * expandRate;
      } else if (value <= expandEnd + 0.5 * KNEE_WIDTH) {
        out = value + maxGain + (1 - expandRate) * (Math.pow(value - expandEnd - 0.5 * KNEE_WIDTH, 2) / (2 * KNEE_WIDTH));
      } else if (value <= compressStart - 0.5 * KNEE_WIDTH) {
        out = value + maxGain;
      } else if (value <= compressStart + 0.5 * KNEE_WIDTH) {
        out = value + maxGain + (compressRate - 1) * Math.pow(value - compressStart + 0.5 * KNEE_WIDTH, 2) / (2 * KNEE_WIDTH);
      } else {
        out = compressStart + maxGain + (value - compressStart) * compressRate;
      }
      x.push(value);
      y.push(out);
    }
    return { x, y };
  }

  function maximizerCurve(maximizer) {
    const threshold = number(maximizer.max_threshold, -3);
    const width = -threshold * 2;
    const x = [];
    const y = [];
    for (let i = -1000; i < 100; i++) {
      const value = i * 0.1;
      let out;
      if (value <= -width / 2 + threshold) out = value;
      else if (Math.abs(value - threshold) <= width / 2) out = value - Math.pow(value - threshold + width / 2, 2) / (2 * width);
      else out = threshold;
      x.push(value);
      y.push(out);
    }
    return { x, y };
  }

  function drawCurrentModule() {
    const ch = currentChannel();
    if (state.currentModule === 'spk') {
      const canvas = document.getElementById('effectGraph');
      const response = ch.spk.response;
      if (state.activePlot === 'total' && response.x.length) {
        const eq = eqResponse(ch);
        const y = response.x.map((x, i) => response.y[i] + interpolate(eq.x, eq.y, x));
        drawLogResponse(canvas, response.x, y, state.global.sampleRate);
      } else {
        drawLogResponse(canvas, response.x, response.y, state.global.sampleRate);
      }
    } else if (state.currentModule === 'eq') {
      const eq = eqResponse(ch);
      drawLogResponse(document.getElementById('effectGraph'), eq.x, eq.y, state.global.sampleRate, -30, 30);
    } else if (state.currentModule === 'mbdrc') {
      drawMapping(document.getElementById('effectGraph'), drcCurve(ch.mbdrc.bands[state.selectedMbdrc]), [-100, 0], [-100, 0]);
    } else if (state.currentModule === 'maximizer') {
      drawMapping(document.getElementById('effectAgcGraph'), drcCurve(ch.maximizer.agc), [-100, 0], [-100, 0]);
      drawMapping(document.getElementById('effectMaxGraph'), maximizerCurve(ch.maximizer.maximizer), [-100, 10], [-100, 0]);
    }
  }

  function canvasContext(canvas) {
    if (!canvas) return null;
    const rect = canvas.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    const width = Math.max(320, Math.floor(rect.width || canvas.clientWidth || 600));
    const height = Math.max(180, Math.floor(rect.height || canvas.clientHeight || canvas.height || 260));
    canvas.width = Math.floor(width * dpr);
    canvas.height = Math.floor(height * dpr);
    const ctx = canvas.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    return { ctx, width, height };
  }

  function drawFrame(ctx, width, height) {
    ctx.clearRect(0, 0, width, height);
    ctx.fillStyle = '#18212a';
    ctx.fillRect(0, 0, width, height);
    ctx.strokeStyle = '#344453';
    ctx.lineWidth = 1;
    for (let i = 0; i <= 8; i++) {
      const x = 44 + (width - 58) * i / 8;
      ctx.beginPath();
      ctx.moveTo(x, 12);
      ctx.lineTo(x, height - 32);
      ctx.stroke();
    }
    for (let i = 0; i <= 6; i++) {
      const y = 12 + (height - 44) * i / 6;
      ctx.beginPath();
      ctx.moveTo(44, y);
      ctx.lineTo(width - 14, y);
      ctx.stroke();
    }
  }

  function drawLogResponse(canvas, xs, ys, fs, fixedMin, fixedMax) {
    const box = canvasContext(canvas);
    if (!box) return;
    const { ctx, width, height } = box;
    drawFrame(ctx, width, height);
    const plot = { x: 44, y: 12, w: width - 58, h: height - 44 };
    const minFreq = 20;
    const maxFreq = Math.max(40, Number(fs) / 2 || 24000);
    const validY = ys.filter(v => Number.isFinite(v));
    const yMin = fixedMin != null ? fixedMin : (validY.length ? Math.min(...validY) - 10 : -30);
    const yMax = fixedMax != null ? fixedMax : (validY.length ? Math.max(...validY) + 10 : 30);
    const fx = freq => plot.x + (Math.log2(Math.max(minFreq, freq)) - Math.log2(minFreq)) / (Math.log2(maxFreq) - Math.log2(minFreq)) * plot.w;
    const fy = db => plot.y + (yMax - db) / Math.max(1e-9, yMax - yMin) * plot.h;

    drawAxisLabels(ctx, width, height, `${fmt(yMin)} dB`, `${fmt(yMax)} dB`);
    if (!xs || xs.length < 2) return;
    ctx.strokeStyle = '#36c57e';
    ctx.lineWidth = 2;
    ctx.beginPath();
    let started = false;
    xs.forEach((x, i) => {
      const y = ys[i];
      if (!Number.isFinite(x) || !Number.isFinite(y) || x < minFreq || x > maxFreq) return;
      const px = fx(x);
      const py = fy(y);
      if (!started) {
        ctx.moveTo(px, py);
        started = true;
      } else {
        ctx.lineTo(px, py);
      }
    });
    ctx.stroke();
  }

  function drawMapping(canvas, curve, xRange, yRange) {
    const box = canvasContext(canvas);
    if (!box) return;
    const { ctx, width, height } = box;
    drawFrame(ctx, width, height);
    const plot = { x: 44, y: 12, w: width - 58, h: height - 44 };
    const fx = x => plot.x + (x - xRange[0]) / (xRange[1] - xRange[0]) * plot.w;
    const fy = y => plot.y + (yRange[1] - y) / (yRange[1] - yRange[0]) * plot.h;
    drawAxisLabels(ctx, width, height, 'Output Amplitude [dB]', 'Input Amplitude [dB]');
    ctx.strokeStyle = '#c9514a';
    ctx.setLineDash([5, 4]);
    ctx.beginPath();
    ctx.moveTo(fx(Math.max(xRange[0], yRange[0])), fy(Math.max(xRange[0], yRange[0])));
    ctx.lineTo(fx(Math.min(xRange[1], yRange[1])), fy(Math.min(xRange[1], yRange[1])));
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.strokeStyle = '#36c57e';
    ctx.lineWidth = 2;
    ctx.beginPath();
    curve.x.forEach((x, i) => {
      const y = curve.y[i];
      const px = fx(x);
      const py = fy(y);
      i === 0 ? ctx.moveTo(px, py) : ctx.lineTo(px, py);
    });
    ctx.stroke();
  }

  function drawAxisLabels(ctx, width, height, left, bottom) {
    ctx.fillStyle = '#8ea0b0';
    ctx.font = '11px Consolas, Menlo, monospace';
    ctx.fillText(left, 8, 22);
    ctx.fillText(bottom, Math.max(50, width - 185), height - 10);
  }

  function clamp(value, min, max) {
    return Math.max(min, Math.min(max, value));
  }

  function totalOutput() {
    const g = state.global;
    const parts = sanitizeVersion(g.userVersion, true).split('.').map(x => intValue(x, 0));
    const out = new Array(20).fill(0);
    out[0] = intValue(g.sampleRate, 48000);
    out[1] = intValue(g.bitRate, 16);
    out[2] = intValue(g.link, 0);
    out[3] = intValue(g.numCh, 2);
    out[4] = 2.0;
    out[5] = parts[0] || 0;
    out[6] = parts[1] || 0;
    out[7] = parts[2] || 0;
    const keys = ['autogain', 'bass', 'exciter', 'deesser', 'eq10', 'mbdrc', 'agc', 'maximizer'];
    keys.forEach((key, i) => { out[10 + i] = number(g.switches[key], 0); });
    return out;
  }

  function spkOutput(ch) {
    return [number(ch.spk.preGain, 0), 0, 0, 0, 0];
  }

  function autogainOutput(ch) {
    const a = ch.autogain;
    return [a.target_i_dB, a.attack_time, a.release_time, a.r128Wins, a.r128Steps, 0, 0, 0, 0, 0].map(v => number(v, 0));
  }

  function nolinearOutput(ch) {
    const n = ch.nolinear;
    return [
      n.bass.amount_dB, n.bass.drive, n.bass.blend, n.bass.freq, n.bass.floor_active, n.bass.floor_freq,
      n.exciter.even_harmonics, n.exciter.distortion_amount, n.exciter.cutoff, n.exciter.mix,
      n.deesser.f0, n.deesser.threshold,
    ].concat(new Array(28).fill(0)).map(v => number(v, 0));
  }

  function eqOutput(ch) {
    const out = new Array(50).fill(0);
    let index = 0;
    ch.eq.filters.forEach(filter => {
      out[index++] = number(filter.enable, 0);
      out[index++] = intValue(filter.filterType, 0);
      out[index++] = number(filter.fc, 0);
      out[index++] = number(filter.Q, 0);
      out[index++] = number(filter.boost, 0);
    });
    return out;
  }

  function mbdrcOutput(ch) {
    const out = new Array(100).fill(0);
    out[0] = intValue(ch.mbdrc.crossBand, 2);
    let index = 10;
    ch.mbdrc.bands.forEach(band => {
      [
        'freq_start', 'freq_end', 'gain_dB', 'drc_enable', 'compress_start', 'expand_end',
        'noise_threshold', 'max_gain', 'max_peak', 'attack_time', 'release_time', 'hold_time',
      ].forEach((key, offset) => { out[index + offset] = number(band[key], 0); });
      index += 20;
    });
    return out;
  }

  function maximizerOutput(ch) {
    const out = new Array(20).fill(0);
    const max = ch.maximizer.maximizer;
    const agc = ch.maximizer.agc;
    out[0] = number(max.max_threshold, 0);
    out[1] = number(max.ceiling, 0);
    out[2] = number(max.release, 0);
    ['compress_start', 'expand_end', 'noise_threshold', 'max_gain', 'max_peak', 'attack_time', 'release_time', 'hold_time']
      .forEach((key, i) => { out[3 + i] = number(agc[key], 0); });
    return out;
  }

  function putSlice(arr, start, deleteCount, values) {
    arr.splice(start, deleteCount, ...values.map(v => number(v, 0)));
  }

  function prepareBinFloats() {
    const arr = new Array(550).fill(0);
    putSlice(arr, BIN_INDEX.total, 20, totalOutput());
    state.channels.forEach((ch, i) => putSlice(arr, BIN_INDEX.spk + i * 5, 5, spkOutput(ch)));
    state.channels.forEach((ch, i) => putSlice(arr, BIN_INDEX.autogain + i * 10, 10, autogainOutput(ch)));
    state.channels.forEach((ch, i) => putSlice(arr, BIN_INDEX.bass + i * 10, 6, nolinearOutput(ch).slice(0, 6)));
    state.channels.forEach((ch, i) => putSlice(arr, BIN_INDEX.exciter + i * 5, 4, nolinearOutput(ch).slice(6, 10)));
    state.channels.forEach((ch, i) => putSlice(arr, BIN_INDEX.deesser + i * 5, 5, nolinearOutput(ch).slice(10, 12)));
    state.channels.forEach((ch, i) => putSlice(arr, BIN_INDEX.eq + i * 50, 50, eqOutput(ch)));
    state.channels.forEach((ch, i) => putSlice(arr, BIN_INDEX.mbdrc + i * 100, 100, mbdrcOutput(ch)));
    state.channels.forEach((ch, i) => putSlice(arr, BIN_INDEX.maximizer + i * 20, 20, maximizerOutput(ch)));
    return arr;
  }

  function importBinFloats(floats) {
    resetAll();
    const data = floats.slice();
    while (data.length < 544) data.push(0);
    const g = state.global;
    g.sampleRate = intValue(data[0], 48000);
    g.bitRate = intValue(data[1], 16);
    g.link = intValue(data[2], 0);
    g.numCh = intValue(data[3], 2);
    g.userVersion = `${intValue(data[5], 0)}.${intValue(data[6], 0)}.${intValue(data[7], 0)}`;
    const keys = ['autogain', 'bass', 'exciter', 'deesser', 'eq10', 'mbdrc', 'agc', 'maximizer'];
    keys.forEach((key, i) => { g.switches[key] = number(data[10 + i], 0); });
    state.channels.forEach((ch, i) => {
      ch.spk.preGain = number(data[BIN_INDEX.spk + i * 5], 0);
      const ag = data.slice(BIN_INDEX.autogain + i * 10, BIN_INDEX.autogain + i * 10 + 5);
      ['target_i_dB', 'attack_time', 'release_time', 'r128Wins', 'r128Steps']
        .forEach((key, idx) => { ch.autogain[key] = number(ag[idx], ch.autogain[key]); });
      const nl = new Array(40).fill(0);
      nl.splice(0, 6, ...data.slice(BIN_INDEX.bass + i * 10, BIN_INDEX.bass + i * 10 + 6));
      nl.splice(6, 4, ...data.slice(BIN_INDEX.exciter + i * 5, BIN_INDEX.exciter + i * 5 + 4));
      nl.splice(10, 2, ...data.slice(BIN_INDEX.deesser + i * 5, BIN_INDEX.deesser + i * 5 + 2));
      ['amount_dB', 'drive', 'blend', 'freq', 'floor_active', 'floor_freq']
        .forEach((key, idx) => { ch.nolinear.bass[key] = number(nl[idx], ch.nolinear.bass[key]); });
      ['even_harmonics', 'distortion_amount', 'cutoff', 'mix']
        .forEach((key, idx) => { ch.nolinear.exciter[key] = number(nl[6 + idx], ch.nolinear.exciter[key]); });
      ['f0', 'threshold'].forEach((key, idx) => { ch.nolinear.deesser[key] = number(nl[10 + idx], ch.nolinear.deesser[key]); });
      const eq = data.slice(BIN_INDEX.eq + i * 50, BIN_INDEX.eq + i * 50 + 50);
      for (let f = 0; f < 10; f++) {
        const base = f * 5;
        ch.eq.filters[f] = {
          enable: number(eq[base], 0),
          filterType: intValue(eq[base + 1], 0),
          fc: number(eq[base + 2], ch.eq.filters[f].fc),
          Q: Math.round(number(eq[base + 3], ch.eq.filters[f].Q) * 100) / 100,
          boost: number(eq[base + 4], ch.eq.filters[f].boost),
        };
      }
      const mb = data.slice(BIN_INDEX.mbdrc + i * 100, BIN_INDEX.mbdrc + i * 100 + 100);
      ch.mbdrc.crossBand = [2, 3, 4].includes(intValue(mb[0], 2)) ? intValue(mb[0], 2) : 2;
      let mbIndex = 10;
      ch.mbdrc.bands.forEach(band => {
        ['freq_start', 'freq_end', 'gain_dB', 'drc_enable', 'compress_start', 'expand_end',
          'noise_threshold', 'max_gain', 'max_peak', 'attack_time', 'release_time', 'hold_time']
          .forEach((key, idx) => { band[key] = number(mb[mbIndex + idx], band[key]); });
        mbIndex += 20;
      });
      const mx = data.slice(BIN_INDEX.maximizer + i * 20, BIN_INDEX.maximizer + i * 20 + 20);
      ['max_threshold', 'ceiling', 'release'].forEach((key, idx) => {
        ch.maximizer.maximizer[key] = number(mx[idx], ch.maximizer.maximizer[key]);
      });
      ['compress_start', 'expand_end', 'noise_threshold', 'max_gain', 'max_peak', 'attack_time', 'release_time', 'hold_time']
        .forEach((key, idx) => { ch.maximizer.agc[key] = number(mx[3 + idx], ch.maximizer.agc[key]); });
    });
  }

  function floatsToBuffer(floats) {
    const buffer = new ArrayBuffer(floats.length * 4);
    const view = new DataView(buffer);
    floats.forEach((value, i) => view.setFloat32(i * 4, number(value, 0), true));
    return buffer;
  }

  function bufferToFloats(buffer) {
    if (buffer.byteLength % 4 !== 0) throw new Error(label('invalid_bin'));
    const view = new DataView(buffer);
    const out = [];
    for (let i = 0; i < buffer.byteLength; i += 4) out.push(view.getFloat32(i, true));
    return out;
  }

  function bufferToBase64(buffer) {
    const bytes = new Uint8Array(buffer);
    let binary = '';
    const chunk = 0x8000;
    for (let i = 0; i < bytes.length; i += chunk) {
      binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
    }
    return btoa(binary);
  }

  function base64ToBuffer(text) {
    const binary = atob(text);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return bytes.buffer;
  }

  function effectBinName() {
    return `rkaudio_effect_eqdrc_${intValue(state.global.sampleRate, 48000)}hz_${intValue(state.global.numCh, 2)}ch.bin`;
  }

  function downloadBuffer(buffer, fileName) {
    const blob = new Blob([buffer], { type: 'application/octet-stream' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = fileName;
    a.click();
    URL.revokeObjectURL(a.href);
  }

  function chooseBinFile() {
    const input = document.getElementById('fileEffectBin');
    if (!input) return;
    input.onchange = () => {
      const file = input.files && input.files[0];
      if (!file) return;
      const reader = new FileReader();
      reader.onload = e => {
        try {
          importBinFloats(bufferToFloats(e.target.result));
          logLine(`${label('load_ok')}: ${file.name}`);
          render();
        } catch (err) {
          alert(err.message);
          logLine(err.message);
        }
      };
      reader.readAsArrayBuffer(file);
      input.value = '';
    };
    input.click();
  }

  function saveBin() {
    const floats = prepareBinFloats();
    const buffer = floatsToBuffer(floats);
    downloadBuffer(buffer, effectBinName());
    logLine(`${label('save_ok')}: ${effectBinName()} (${floats.length} floats)`);
    render();
  }

  async function pushBin() {
    try {
      await ensureBridgeReady();
      const buffer = floatsToBuffer(prepareBinFloats());
      const result = await sendBridgeCommand('effect.bin.push', {
        target: currentBridgeTarget(),
        name: effectBinName(),
        base64: bufferToBase64(buffer),
      }, 20000);
      logLine(`${label('push_ok')}: ${result.remotePath || effectBinName()}`);
    } catch (err) {
      alert(label('bridge_needed') + ': ' + err.message);
      logLine(`${label('push')}: ${err.message}`);
    }
  }

  async function pullBin() {
    try {
      await ensureBridgeReady();
      const result = await sendBridgeCommand('effect.bin.pull', {
        target: currentBridgeTarget(),
        name: effectBinName(),
      }, 20000);
      const buffer = base64ToBuffer(result.base64 || '');
      importBinFloats(bufferToFloats(buffer));
      downloadBuffer(buffer, result.name || effectBinName());
      logLine(`${label('pull_ok')}: ${result.remotePath || result.name || effectBinName()}`);
      render();
    } catch (err) {
      alert(label('bridge_needed') + ': ' + err.message);
      logLine(`${label('pull')}: ${err.message}`);
    }
  }

  function refreshLanguage() {
    if (state.visible) render();
  }

  window.openEffectTuningPage = openPage;
  window.closeEffectTuningPage = closePage;
  window.refreshEffectTuningLanguage = refreshLanguage;
  window.EffectTuning = {
    prepareBinFloats,
    importBinFloats,
    state,
  };
})();
