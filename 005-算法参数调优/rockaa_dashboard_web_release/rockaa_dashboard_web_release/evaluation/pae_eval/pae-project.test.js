'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

const translations = {
  pae_project_warn_bare: 'bare warning',
  pae_project_warn_rate: 'rate warning',
  pae_project_warn_sensitivity: 'sensitivity warning',
};
const context = {
  Blob,
  FileReader: function FileReader() {},
  URL: { createObjectURL() {}, revokeObjectURL() {} },
  document: { createElement() { return {}; }, body: { appendChild() {} } },
  setTimeout() {},
  state: { deviceSettings: { tx: { micChannels: 3, refChannels: 2 } } },
  lang: 'zh',
  t(key) { return translations[key] || key; },
  htmlEscape(value) { return String(value); },
};
vm.createContext(context);
vm.runInContext(fs.readFileSync(`${__dirname}/pae-evaluation.js`, 'utf8'), context);

function evaluate(expression) {
  return vm.runInContext(expression, context);
}

assert.equal(evaluate('Object.values(PAE_PROJECT_WEIGHTS).reduce((sum, value) => sum + value, 0)'), 1);
assert.equal(evaluate('emptyPaeProject().micCount'), '3');
assert.equal(evaluate('emptyPaeProject().speakerCount'), '2');
assert.equal(evaluate('paeProjectValidation(emptyPaeProject()).valid'), true);
assert.equal(evaluate('paeMaxUndistortedVoltage(emptyPaeProject())'), '4.00');

evaluate(`paeState.project = Object.assign(emptyPaeProject(), {
  assemblyState: 'bare', sampleRate: '48000', pickupMinDistance: '300', pickupMaxDistance: '100'
})`);
assert.deepEqual(Array.from(evaluate('paeProjectValidation(paeState.project).blocking')), ['pickup_range']);
assert.match(evaluate('paeProjectWarnings(paeState.project).join("|")'), /bare warning/);
assert.match(evaluate('paeProjectWarnings(paeState.project).join("|")'), /rate warning/);
assert.match(evaluate('paeProjectWarnings(paeState.project).join("|")'), /sensitivity warning/);

evaluate(`Object.assign(paeState.project, { pickupMinDistance: '100', pickupMaxDistance: '200' })`);
assert.equal(evaluate('paeProjectValidation(paeState.project).valid'), true);
assert.equal(evaluate('paeProjectScore(paeState.project).total'), 59);
assert.equal(evaluate('paeProjectScore(paeState.project).level'), 'low');

console.log('PAE project profile tests passed');
