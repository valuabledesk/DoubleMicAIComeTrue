'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

const translations = {
  pae_photos_title: '设备实物照片',
  pae_photos_note: '固定顺序',
  pae_photo_front: '正面图说明', pae_photo_front_short: '正面图',
  pae_photo_side: '侧面图说明', pae_photo_side_short: '侧面图',
  pae_photo_top: '俯视图说明', pae_photo_top_short: '俯视图',
  pae_photo_drag: '拖动交换', pae_missing_photos: '缺少资料：{views}',
  pae_photo_analysis: '照片与实测综合分析',
  pae_photo_evidence: '综合依据：{views}', pae_photo_audio_only: '仅实测音频',
  pae_photo_check_speaker: '检查 SPK 固定', pae_photo_check_mic: '检查 Mic 密封',
  pae_photo_check_gain: '检查增益', pae_photo_check_reference: '检查 Far',
  pae_photo_check_normal: '未触发门限',
};
const context = {
  Blob,
  FileReader: function FileReader() {},
  URL: { createObjectURL() { return 'blob:test'; }, revokeObjectURL() {} },
  document: { createElement() { return {}; }, body: { appendChild() {} } },
  setTimeout(callback) { callback(); },
  lang: 'zh',
  t(key) { return translations[key] || key; },
  htmlEscape(value) { return String(value); },
};
vm.createContext(context);
vm.runInContext(fs.readFileSync(`${__dirname}/pae-evaluation.js`, 'utf8'), context);

function compose(photoNames, flags) {
  context.photoNames = photoNames;
  context.flags = flags;
  vm.runInContext(`
    paeState.panel = null;
    paeState.baseReportHtml = '<h3>优化建议</h3><h3>判定依据图</h3>';
    paeState.photos = photoNames.map((name) => ({name, dataUri: 'data:image/jpeg;base64,AA=='}));
    paeState.metrics = {diagnostic_flags: flags};
    composePaeReport();
  `, context);
  return vm.runInContext('paeState.reportHtml', context);
}

assert.match(compose([], []), /缺少资料：正面图、侧面图、俯视图/);
assert.match(compose([], []), /仅实测音频/);
assert.match(compose(['front'], ['multitone']), /正面图说明/);
assert.match(compose(['front'], ['multitone']), /缺少资料：侧面图、俯视图/);
assert.match(compose(['front'], ['multitone']), /检查 SPK 固定/);
assert.match(compose(['front', 'side'], ['coherence']), /缺少资料：俯视图/);
assert.match(compose(['front', 'side'], ['coherence']), /检查 Mic 密封/);
assert.doesNotMatch(compose(['front', 'side', 'top'], []), /缺少资料/);

compose(['front', 'side', 'top'], []);
vm.runInContext('swapPaePhotos(0, 2)', context);
assert.deepEqual(Array.from(vm.runInContext('paeState.photos.map((photo) => photo.name)', context)),
  ['top', 'side', 'front']);
console.log('PAE report photo evidence tests passed');
