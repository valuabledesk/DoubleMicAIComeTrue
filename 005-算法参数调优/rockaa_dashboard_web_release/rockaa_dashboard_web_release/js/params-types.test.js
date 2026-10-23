'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

const source = fs.readFileSync(`${__dirname}/params.js`, 'utf8');
const start = source.indexOf('function valueToText(');
const end = source.indexOf('function onParamInput(', start);
assert(start >= 0 && end > start, 'parameter conversion source was not found');

const context = {};
vm.createContext(context);
vm.runInContext(source.slice(start, end), context);

const agcFloatFields = [
  'attack_time', 'release_time', 'max_gain', 'max_peak',
  'fRth0', 'fRk0', 'fRth1', 'bits', 'frm_num', 'attenuate_time',
  'fRth2', 'fRk1', 'fRk2', 'fLineGainDb',
  'swSmL0', 'swSmL1', 'swSmL2',
];

for (const field of agcFloatFields) {
  assert.equal(context.paramHint(['agc', field], 40), 'float (integer)');
  assert.equal(context.paramHint(['rx', 'agc', field], 40), 'float (integer)');
  assert.equal(context.paramHint(['agc', field], 40.5), 'float');
  assert.equal(context.paramHint(['rx', 'agc', field], 40.5), 'float');
  assert.equal(context.textToValue('40', 40), 40,
    'legacy integer JSON values must remain integers');
  assert.equal(context.textToValue('40.5', 40), 40.5,
    'fractional AGC values must be accepted');
}

assert.equal(context.paramHint(['agc', 'attack_time'], 'float:40'), 'float');
assert.equal(context.paramHint(['agc', 'status'], 'enable'), 'enable / disable');

console.log('parameter type tests passed');
