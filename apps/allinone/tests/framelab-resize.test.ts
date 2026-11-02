import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const source = fs.readFileSync(new URL('../public/framelab/app.js', import.meta.url), 'utf8');
const handlers = source.slice(source.indexOf("canvas.addEventListener('pointermove'"), source.indexOf('let resultURL'));

test('resize changes only the selected watermark size, clamps it, and saves on release', () => {
  for (const kind of ['custom', 'exif']) {
    const prefix = kind === 'exif' ? 'exif-watermark' : 'watermark';
    const controls: Record<string, any> = {};
    for (const p of ['watermark', 'exif-watermark']) {
      controls[p + '-size'] = { value: '45', min: '6', max: '180' };
      controls[p + '-size-value'] = { textContent: '4.5%' };
      controls[p + '-position'] = { value: 'seam' };
      controls[p + '-x'] = { value: '50' };
      controls[p + '-y'] = { value: '50' };
    }
    const listeners: Record<string, (e: any) => void> = {};
    let saves = 0;
    const state = vm.createContext({
      canvas: { addEventListener: (name: string, callback: any) => { listeners[name] = callback; } },
      $: (id: string) => controls[id],
      drag: { kind, mode: 'resize', pointerId: 1, startY: 100, startSize: 45 },
      focusX: 0.4, focusY: 0.6, zoom: 1.5,
      sync() {}, saveSettings() { saves++; },
    });
    vm.runInContext(handlers, state);
    listeners.pointermove({ pointerId: 2, clientY: 200 });
    assert.equal(controls[prefix + '-size'].value, '45');
    listeners.pointermove({ pointerId: 1, clientY: 200 });
    assert.equal(controls[prefix + '-size'].value, '90');
    assert.equal(controls[prefix + '-size-value'].textContent, '9%');
    listeners.pointermove({ pointerId: 1, clientY: 10000 });
    assert.equal(controls[prefix + '-size'].value, '180');
    listeners.pointermove({ pointerId: 1, clientY: -10000 });
    assert.equal(controls[prefix + '-size'].value, '6');
    for (const p of ['watermark', 'exif-watermark']) {
      assert.equal(controls[p + '-position'].value, 'seam');
      assert.equal(controls[p + '-x'].value, '50');
      assert.equal(controls[p + '-y'].value, '50');
      if (p !== prefix) assert.equal(controls[p + '-size'].value, '45');
    }
    assert.equal(state.focusX, 0.4);
    assert.equal(state.focusY, 0.6);
    assert.equal(state.zoom, 1.5);
    listeners.pointerup({ pointerId: 1 });
    assert.equal(state.drag, null);
    assert.equal(saves, 1);
    listeners.lostpointercapture({ pointerId: 1 });
    assert.equal(saves, 1);
  }
});
