'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

const source = fs.readFileSync(`${__dirname}/simulation.js`, 'utf8');
const extract = (start, end) => source.slice(source.indexOf(start), source.indexOf(end));
const context = { Number };
vm.createContext(context);
vm.runInContext(extract('function parseOnlineSedLog(', 'function appendSedEventSpan('), context);
vm.runInContext(extract('function appendSedEventSpan(', 'function rxSourcePayload('), context);

const chunk = [
  'sed event - babycry: 1, buzzer: 0, glassbreaking: 0, t: 40.032s',
  'sed event - babycry: 1, buzzer: 0, glassbreaking: 0, t: 40.048s',
  '== sed events: babycry:388 buzzer:0 glassbreaking:0, cost avg:372us ==',
].join('\n');
const parsed = context.parseOnlineSedLog(chunk);
assert.deepEqual(JSON.parse(JSON.stringify(parsed.summary)), { bcd: 388, buz: 0, gbs: 0 });
assert.equal(parsed.events.length, 2, 'all events in one bridge chunk must be parsed');

const panel = {
  sedSpans: [],
  inputWave: { eventSpans: [] },
  outputWave: { eventSpans: [] },
};
for (const event of parsed.events)
  context.appendSedEventSpan(panel, event.time);
assert.deepEqual(JSON.parse(JSON.stringify(panel.sedSpans)), [{ t0: 40.016, t1: 40.048 }]);
assert.equal(panel.inputWave.eventSpans, panel.sedSpans);
assert.equal(panel.outputWave.eventSpans, panel.sedSpans);

console.log('SED online event timeline tests passed');
