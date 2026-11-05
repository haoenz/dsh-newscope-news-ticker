// Browser-test tooling only. Playwright's default focus emulation makes even
// background tabs report visible. Disable that automation override in memory;
// never replace document.hidden/visibilityState, app timers, or page geometry.
const Module = require('node:module');
const path = require('node:path');
module.exports = function nativeBrowserVisibility() {
  const bundle = path.join(path.dirname(require.resolve('playwright-core', {paths:[require.resolve('playwright')]})), 'lib/coreBundle.js');
  const original = Module.prototype._compile;
  let patched = 0;
  Module.prototype._compile = function(source, filename) {
    if (filename === bundle) {
      const from = 'this._client.send("Emulation.setFocusEmulationEnabled", { enabled: true })';
      if (source.split(from).length !== 2) throw new Error('Playwright changed: audit native-visibility setup before accepting background tests');
      source = source.replace(from, 'this._client.send("Emulation.setFocusEmulationEnabled", { enabled: false })');
      patched++;
    }
    return original.call(this, source, filename);
  };
  try {
    const playwright = require('playwright');
    if (patched !== 1) throw new Error('Run native-visibility browser tests in a fresh Node process');
    return playwright;
  } finally { Module.prototype._compile = original; }
};
