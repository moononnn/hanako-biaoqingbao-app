import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { previewPosition, createStickerPreview } from '../ui/assets/sticker-preview.js';

test('preview fits viewport at each edge in narrow and wide panels', () => {
  for (const width of [320, 640, 1000]) for (const height of [160, 480]) {
    for (const left of [0, width - 80]) for (const top of [0, height - 80]) {
      const p = previewPosition({ left, right: left + 80, top, height: 80 }, width, height);
      assert.ok(p.left >= 8 && p.top >= 8);
      assert.ok(p.left + p.width <= width - 8 && p.top + p.height <= height - 8);
    }
  }
});
function fixture() {
  class Element {
    constructor() { this.style = {}; this.children = []; this.listeners = new Map(); this.isConnected = true; }
    append(...items) { this.children.push(...items); }
    setAttribute() {} removeAttribute(key) { delete this[key]; }
    addEventListener(key, callback) { this.listeners.set(key, callback); }
    getBoundingClientRect() { return { left: 250, right: 310, top: 40, height: 80 }; }
    remove() { this.isConnected = false; }
  }
  const doc = { body: new Element(), createElement: () => new Element(), addEventListener() {} };
  let counter = 0; const timers = new Map();
  const view = { innerWidth: 320, innerHeight: 480, setTimeout: callback => { timers.set(++counter, callback); return counter; }, clearTimeout: key => timers.delete(key), addEventListener() {}, removeEventListener() {} };
  const deferred = new Map();
  const preview = createStickerPreview({ doc, view, description: id => id, imageUrl: id => new Promise(resolve => deferred.set(id, resolve)) });
  const a = new Element(), b = new Element(); preview.bind(a, 'a'); preview.bind(b, 'b');
  const tick = () => { for (const [key, callback] of [...timers]) { timers.delete(key); callback(); } };
  return { a, b, preview, view, tick, deferred, element: doc.body.children[0] };
}
test('leaving before delay never starts a preview request', () => {
  const f = fixture(); f.a.listeners.get('pointerenter')({ pointerType: 'mouse' });
  f.a.listeners.get('pointerleave')(); f.tick();
  assert.equal(f.deferred.size, 0); assert.equal(f.element.hidden, true);
});
test('late old image cannot replace the currently hovered image', async () => {
  const f = fixture();
  f.a.listeners.get('pointerenter')({ pointerType: 'mouse' }); f.tick();
  f.b.listeners.get('pointerenter')({ pointerType: 'mouse' }); f.tick();
  f.deferred.get('b')('blob:new'); await Promise.resolve();
  f.deferred.get('a')('blob:old'); await Promise.resolve();
  assert.equal(f.element.children[0].src, 'blob:new');
  assert.equal(f.element.children[1].textContent, 'b');
});
test('hide invalidates loading image, touch never opens, zero-sized views stay hidden', async () => {
  const f = fixture();
  f.a.listeners.get('pointerenter')({ pointerType: 'touch' }); f.tick(); assert.equal(f.deferred.size, 0);
  f.a.listeners.get('focus')({ type: 'focus' }); f.tick();
  f.preview.hide(); f.deferred.get('a')('blob:late'); await Promise.resolve();
  assert.equal(f.element.hidden, true); assert.equal(f.element.children[0].src, undefined);
  f.view.innerWidth = 0; f.a.listeners.get('focus')({ type: 'focus' }); f.tick(); assert.equal(f.element.hidden, true);
});
test('gallery keeps intrinsic row height and root-level preview uses contain', () => {
  const css = fs.readFileSync(new URL('../ui/assets/sticker-compose.css', import.meta.url), 'utf8');
  const ui = fs.readFileSync(new URL('../ui/assets/sticker-compose.js', import.meta.url), 'utf8');
  assert.match(css, /grid-auto-rows:max-content/); assert.match(css, /min-height:max-content/);
  assert.match(css, /#sticker-preview\{position:fixed/); assert.match(css, /#sticker-preview img\{[^}]*object-fit:contain/);
  assert.match(ui, /stickerPreview\.bind\(pick, item.id\)/); assert.match(ui, /addEventListener\('scroll', \(\) => \{ stickerPreview.hide\(\)/);
});
