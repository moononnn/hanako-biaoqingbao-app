import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { prepareMessageCard, registerMessageCardRoutes, __resetRenderClaimsForTests } from '../lib/ball-message-card.js';

function fixture(t) {
  __resetRenderClaimsForTests();
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bqb-claim-diag-'));
  t.after(() => { __resetRenderClaimsForTests(); fs.rmSync(dataDir, { recursive: true, force: true }); });
  const record = prepareMessageCard({ dataDir, sessionId: 'session-one', requestId: 'diag',
    bytes: Buffer.from('image'), mimeType: 'image/png' });
  const routes = new Map();
  registerMessageCardRoutes({ get(route, handler) { routes.set(route, handler); },
    post(route, handler) { routes.set(route, handler); } }, dataDir);
  const query = (instance, view = 'render-diag-0.2.5') => routes.get('/api/paper-plane-message')({
    req: { query(name) { return { id: record.id, instance, view }[name]; } },
    json(body) { return body; },
  });
  const release = (instance, claimToken) => routes.get('/api/paper-plane-message/release')({
    req: { json: async () => ({ id: record.id, instance, claimToken }) }, json: body => body,
  });
  return { dataDir, record, query, release, log: path.join(dataDir, 'card-context-debug.log') };
}

const hash = value => createHash('sha256').update(value).digest('hex');

test('claim diagnostics record backend identity and decisions without exposing surface credentials', t => {
  const f = fixture(t);
  const first = 'same-prefix-'.repeat(30) + 'private-lease-one';
  const second = 'same-prefix-'.repeat(30) + 'private-lease-two';
  assert.equal(f.query(first).data.duplicate, false);
  assert.equal(f.query(second).data.duplicate, true);
  assert.equal(f.query(first).data.duplicate, false);
  const raw = fs.readFileSync(f.log, 'utf8');
  assert.equal(raw.includes('private-lease'), false);
  const rows = raw.trim().split('\n').map(line => {
    assert.match(line, /^\d{4}-\d\d-\d\dT.*Z \| CLAIM /);
    return JSON.parse(line.split(' | CLAIM ')[1]);
  });
  assert.equal(rows.length, 3);
  assert.deepEqual(rows.map(row => row.claimed), [true, false, true]);
  assert.equal(rows[0].pid, process.pid);
  assert.ok(Number.isFinite(Date.parse(rows[0].moduleStartedAt)));
  assert.equal(rows[0].recordId, f.record.id);
  assert.equal(rows[0].view, 'render-diag-0.2.5');
  assert.equal(rows[0].instanceLength, first.length);
  assert.equal(rows[0].instanceHash, hash(first));
  assert.equal(rows[1].instanceHash, hash(second));
  assert.equal(rows[1].previousHolderHash, hash(first));
  assert.equal(rows[1].holderHash, hash(first));
  assert.ok(rows[1].previousAgeMs >= 0);
  assert.equal(rows[0].previousAgeMs, null);
});

test('claim diagnostics identify absent instance and old page marker while preserving fail-open behavior', t => {
  const f = fixture(t);
  assert.equal(f.query(undefined, undefined).data.duplicate, false);
  const row = JSON.parse(fs.readFileSync(f.log, 'utf8').trim().split(' | CLAIM ')[1]);
  assert.equal(row.instanceLength, 0);
  assert.equal(row.instanceHash, null);
  assert.equal(row.holderHash, null);
  // Explicit blank represents a page which does not send the version marker.
  f.query('', '');
  const last = fs.readFileSync(f.log, 'utf8').trim().split('\n').at(-1);
  assert.equal(JSON.parse(last.split(' | CLAIM ')[1]).view, '');
});

test('release requires the owning instance and current lease token; stale exit cannot release a renewed claim', async t => {
  const f = fixture(t);
  const first = f.query('surface-one').data.claimToken;
  assert.ok(first);
  assert.equal((await f.release('surface-two', first)).released, false);
  const renewed = f.query('surface-one').data.claimToken;
  assert.notEqual(renewed, first);
  assert.equal((await f.release('surface-one', first)).released, false);
  assert.equal(f.query('surface-two').data.duplicate, true);
  assert.equal((await f.release('surface-one', renewed)).released, true);
  assert.equal(f.query('surface-two').data.duplicate, false);
});

test('unwritable claim diagnostics do not change the existing claim decision', t => {
  const f = fixture(t);
  fs.mkdirSync(f.log);
  assert.equal(f.query('surface-one').data.duplicate, false);
  assert.equal(f.query('surface-two').data.duplicate, true);
});
