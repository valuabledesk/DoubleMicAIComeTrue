'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

const commands = [];
let closed = false;
const status = { hidden: true, style: {}, textContent: '' };
const context = {
  Blob,
  FileReader: function FileReader() {},
  URL: { createObjectURL() { return 'blob:test'; }, revokeObjectURL() {} },
  document: {
    createElement() { return {}; },
    body: { appendChild() {} },
    querySelector() { return null; },
  },
  window: { confirm() { return true; } },
  setTimeout(callback) { callback(); },
  lang: 'zh',
  t(key) { return key; },
  htmlEscape(value) { return String(value); },
  appendLogLine() {},
  async ensureBridgeReady() {},
  currentBridgeTarget() { return { adbDevice: 'test-device' }; },
  async sendBridgeCommand(command, body) { commands.push({ command, body }); return { stopped: true }; },
};
vm.createContext(context);
vm.runInContext(fs.readFileSync(`${__dirname}/pae-evaluation.js`, 'utf8'), context);
context.panel = {
  root: { classList: { remove(name) { if (name === 'open') closed = true; } } },
  refs: { close: { disabled: false }, status, log: {} },
};
vm.runInContext('paeState.panel = panel; paeState.running = true;', context);

(async () => {
  await context.closePaeDialog();
  assert.equal(commands.length, 1);
  assert.equal(commands[0].command, 'pae.stop');
  assert.equal(commands[0].body.target.adbDevice, 'test-device');
  assert.equal(closed, true, 'dialog closes only after stop succeeds');
  assert.equal(vm.runInContext('paeState.cancelRequested', context), true);
  console.log('PAE frontend cancellation tests passed');
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
