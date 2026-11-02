import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

// Same extraction pattern as before the multi-watermark refactor: run the canvas
// pointer listeners in an isolated vm context with stubbed controls and state.
const source = fs.readFileSync(new URL('../public/framelab/app.js', import.meta.url), 'utf8');
const handlers = source.slice(source.indexOf("canvas.addEventListener('pointermove'"), source.indexOf('let resultURL'));

function runtime(kind: string, startSize: number) {
  const controls: Record<string, any> = {};
  for (const p of ['watermark', 'exif-watermark']) {
    controls[p + '-size'] = { value: '45', min: '6', max: '180' };
    controls[p + '-size-value'] = { textContent: '4.5%' };
    controls[p + '-position'] = { value: 'seam' };
    controls[p + '-x'] = { value: '50' };
    controls[p + '-y'] = { value: '50' };
    controls[p + '-x-value'] = { textContent: '50%' };
    controls[p + '-y-value'] = { textContent: '50%' };
  }
  const listeners: Record<string, (e: any) => void> = {};
  const layer = { id: 'wm-1', text: 'A', font: 'sans', size: startSize, opacity: 100, color: '#ffffff', position: 'custom', x: 30, y: 40 };
  const state: any = vm.createContext({
    canvas: { addEventListener: (name: string, callback: any) => { listeners[name] = callback; } },
    $: (id: string) => controls[id],
    drag: { kind, mode: 'resize', pointerId: 1, startY: 100, startSize },
    textLayers: [layer],
    activeLayer: () => state.textLayers[0],
    syncTextEditorControls: () => { controls['watermark-size'].value = String(layer.size); },
    focusX: .4, focusY: .6, zoom: 1.5,
    sync() {}, saveSettings() { state.settingsSaves++; }, saveLayers() { state.layerSaves++; },
    settingsSaves: 0, layerSaves: 0,
  });
  vm.runInContext(handlers, state);
  state.textLayers = [layer];
  return { controls, listeners, state, layer };
}

test('text watermark resize updates only the model size and persists via saveLayers', () => {
  const t = runtime('wm-1', 45);
  t.listeners.pointermove({ pointerId: 2, clientY: 200 }); // a foreign pointer is ignored
  assert.equal(t.layer.size, 45);
  t.listeners.pointermove({ pointerId: 1, clientY: 200 }); // +100px doubles the size
  assert.equal(t.layer.size, 90);
  assert.equal(t.controls['watermark-size'].value, '90', 'editor slider mirrors the model');
  t.listeners.pointermove({ pointerId: 1, clientY: 100000 });
  assert.equal(t.layer.size, 180);
  t.listeners.pointermove({ pointerId: 1, clientY: -100000 });
  assert.equal(t.layer.size, 6);
  // Resize never moves the text: position and photo composition stay intact.
  assert.equal(t.layer.position, 'custom');
  assert.equal(t.layer.x, 30);
  assert.equal(t.layer.y, 40);
  assert.equal(t.state.focusX, .4);
  assert.equal(t.state.focusY, .6);
  t.listeners.pointerup({ pointerId: 1 });
  assert.equal(t.state.drag, null);
  assert.equal(t.state.layerSaves, 1);
  assert.equal(t.state.settingsSaves, 0);
});

test('exif watermark resize keeps driving its DOM slider and persists via saveSettings', () => {
  const t = runtime('exif', 45);
  t.listeners.pointermove({ pointerId: 1, clientY: 200 });
  assert.equal(t.controls['exif-watermark-size'].value, '90');
  assert.equal(t.controls['exif-watermark-size-value'].textContent, '9%');
  t.listeners.pointerup({ pointerId: 1 });
  assert.equal(t.state.settingsSaves, 1);
  assert.equal(t.state.layerSaves, 0);
});
