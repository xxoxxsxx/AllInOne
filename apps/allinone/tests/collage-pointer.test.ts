import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

// Exercise the actual canvas listeners with two independently identified touches.
const source = fs.readFileSync(new URL('../public/collage/app.js', import.meta.url), 'utf8');
const listenersSource = source.slice(source.indexOf("preview.addEventListener('pointerdown'"), source.indexOf("preview.addEventListener('keydown'"));

function runtime() {
  const listeners: Record<string, ((event: any) => void)[]> = {};
  const state: any = vm.createContext({
    preview: {addEventListener(name: string, callback: (event: any) => void) {(listeners[name] ??= []).push(callback);}},
    drag: null, wmDrag: null, saves: 0,
    saveWatermarks() { state.saves++; },
  });
  vm.runInContext(listenersSource, state);
  return {state, dispatch(name: string, event: any) { for (const listener of listeners[name]) listener(event); }};
}

test('a second touch cannot replace or terminate a photo drag', () => {
  const t = runtime();
  const drag = {pointer: 1};
  t.state.drag = drag;
  t.dispatch('pointerdown', {pointerId: 2, pointerType: 'touch', button: 0});
  t.dispatch('pointerup', {pointerId: 2});
  assert.equal(t.state.drag, drag);
  t.dispatch('pointercancel', {pointerId: 1});
  assert.equal(t.state.drag, null);
});

test('watermark drag saves only when its own pointer ends', () => {
  const t = runtime();
  const drag = {pointerId: 7};
  t.state.wmDrag = drag;
  t.dispatch('pointerdown', {pointerId: 8, pointerType: 'touch', button: 0});
  t.dispatch('lostpointercapture', {pointerId: 8});
  assert.equal(t.state.wmDrag, drag);
  assert.equal(t.state.saves, 0);
  t.dispatch('pointerup', {pointerId: 7});
  t.dispatch('lostpointercapture', {pointerId: 7});
  assert.equal(t.state.wmDrag, null);
  assert.equal(t.state.saves, 1);
});
