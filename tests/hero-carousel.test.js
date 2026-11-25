import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import ts from 'typescript';

const code = ts.transpileModule(readFileSync(new URL('../src/HeroCarousel.tsx', import.meta.url), 'utf8'), {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022, jsx: ts.JsxEmit.ReactJSX },
}).outputText.replace(/^import .*$/gm, '');
const { heroSlidePlacement } = await import('data:text/javascript;base64,' + Buffer.from(code).toString('base64'));
const motion = (patch = {}) => ({ current: 0, leaving: null, direction: 1, staged: null, settling: null, drag: null, ...patch });
const at = (count, m) => Array.from({ length: count }, (_, i) => heroSlidePlacement(i, count, m));

test('the active slide is centred and parked slides are hidden on the incoming side', () => {
  assert.deepEqual(at(3, motion()), [
    { x: '0px', animate: true, visible: true },
    { x: '100%', animate: false, visible: false },
    { x: '100%', animate: false, visible: false },
  ]);
});

test('going forward parks the next slide on the right for a frame, then slides both left', () => {
  assert.deepEqual(at(3, motion({ staged: 1 }))[1], { x: '100%', animate: false, visible: true });
  const moving = at(3, motion({ current: 1, leaving: 0 }));
  assert.deepEqual(moving[0], { x: '-100%', animate: true, visible: true });
  assert.deepEqual(moving[1], { x: '0px', animate: true, visible: true });
});

test('going back with two titles enters from the left, so the wrap never sweeps across', () => {
  assert.deepEqual(at(2, motion({ direction: -1, staged: 1 }))[1], { x: '-100%', animate: false, visible: true });
  const moving = at(2, motion({ current: 1, leaving: 0, direction: -1 }));
  assert.deepEqual(moving.map(p => p.x), ['100%', '0px']);
});

test('a drag follows the finger with the neighbour it reveals, and a cancelled swipe springs back', () => {
  const left = at(4, motion({ current: 3, drag: -40 }));
  assert.deepEqual(left[3], { x: '-40px', animate: false, visible: true });
  assert.deepEqual(left[0], { x: 'calc(100% + -40px)', animate: false, visible: true }, 'Wraps to the first title');
  const right = at(4, motion({ current: 0, drag: 30 }));
  assert.deepEqual(right[3], { x: 'calc(-100% + 30px)', animate: false, visible: true });
  assert.deepEqual(at(4, motion({ settling: { slide: 1, side: 1 } }))[1], { x: '100%', animate: true, visible: true });
});
