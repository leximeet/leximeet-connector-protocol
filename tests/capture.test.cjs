'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fixtures = require('../fixtures/contracts.json');
const { CaptureStore } = require('../tools/capture-reference.cjs');
const { WorkspaceRouter } = require('../tools/session-reference.cjs');
const { wordKey, hash, canonical } = require('../tools/reference.cjs');
const params = () =>
  structuredClone(fixtures.find((x) => x.name === 'recordEncounter-request').value.params);
const owner = fixtures.find((x) => x.name === 'pair-response').value.result.owner;
const caller = { authorized: true, owner, scopes: ['capture:write'] };
const now = '2026-10-03T00:00:00.000Z';
const store = () => {
  const s = new CaptureStore(owner, [wordKey(params().data.word)], {
    deviceId: '22222222-2222-4222-8222-222222222222',
    timeZone: 'UTC',
  });
  if (params().notebookId) s.records.notebooks[params().notebookId] = { name: '桌面词本' };
  return s;
};

test('A 封存、B 保持原样，连接中 C 只保存在桌面，恢复独立仍是 A', () => {
  const a = [{ word: 'A', plan: '独立计划', draft: '未完成练习' }];
  const router = new WorkspaceRouter(a, '独立账号空间');
  const desktop = store(),
    before = hash(desktop.records);
  router.begin();
  router.bind(owner);
  assert.equal(hash(desktop.records), before);
  const request = router.send(params().mutationId, params());
  const receipt = desktop.capture(caller, request.payload, now);
  router.receive(request, receipt);
  router.restoreIndependent();
  assert.deepEqual(router.localData, a);
  assert.equal(Object.keys(desktop.records.events).length, 1);
  assert.equal(router.localBinding, '独立账号空间');
});
test('ACK 丢失后同 ID 重试返回原回执和原时间，不重复保存', () => {
  const s = store(),
    p = params(),
    first = s.capture(caller, p, now);
  assert.deepEqual(s.capture(caller, p, '2026-10-04T00:00:00.000Z'), first);
  assert.deepEqual(s.operation(caller, p.mutationId).result, first);
  assert.equal(s.records.revision, '1');
  assert.equal(Object.keys(s.records.events).length, 1);
});
test('业务事实的写入者和时钟由 Desktop 确定', () => {
  const result = store().capture(caller, params(), now);
  assert.equal(result.entity.data.origin.clientKind, 'desktop');
  assert.equal(result.entity.data.origin.deviceId, '22222222-2222-4222-8222-222222222222');
  assert.notEqual(result.entity.data.origin.deviceId, owner.desktopInstanceId);
  assert.equal(result.entity.data.occurredAt, now);
});
test('事务中断时私人词、事实、关系、回执均不可见，同 ID 可重试', () => {
  const s = store(),
    p = params(),
    before = structuredClone(s.records);
  assert.throws(() => s.capture(caller, p, now, true), /SIMULATED_TRANSACTION_ABORT/);
  assert.deepEqual(s.records, before);
  assert.equal(s.operation(caller, p.mutationId).status, 'unknown');
  s.capture(caller, p, now);
  assert.equal(s.records.revision, '1');
});
test('同 mutationId 不能改内容，也不能覆盖已有回执', () => {
  const s = store(),
    p = params(),
    first = s.capture(caller, p, now);
  p.data.annotation.note = '更换了意图';
  assert.throws(() => s.capture(caller, p, now), /IDEMPOTENCY_KEY_REUSED/);
  assert.deepEqual(s.operation(caller, p.mutationId).result, first);
});
test('跨 mutationId 的相同 eventId 也去重，复用事件改正文被拒绝', () => {
  const s = store(),
    p = params(),
    first = s.capture(caller, p, now);
  p.mutationId = '另一操作';
  assert.deepEqual(s.capture(caller, p, now), first);
  p.mutationId = '改内容';
  p.data.annotation.note = '变化';
  assert.throws(() => s.capture(caller, p, now), /EVENT_ID_REUSED/);
  assert.equal(s.records.revision, '1');
});
test('先校验工作区与权限，再查询历史回执', () => {
  const s = store(),
    p = params();
  s.capture(caller, p, now);
  for (const field of ['workspaceId', 'generation', 'authorizationEpoch', 'desktopInstanceId']) {
    const changed = { ...caller, owner: { ...owner, [field]: '另一个值' } };
    assert.throws(() => s.operation(changed, p.mutationId), /GENERATION_MISMATCH/);
  }
  assert.throws(() => s.operation({ ...caller, scopes: [] }, p.mutationId), /FORBIDDEN/);
});
test('词本不存在形成拒绝回执，补建词本不会改变原操作终态', () => {
  const s = store(),
    p = params();
  p.notebookId = '不存在的词本';
  assert.throws(() => s.capture(caller, p, now), /ENTITY_NOT_FOUND/);
  assert.equal(s.operation(caller, p.mutationId).status, 'rejected');
  assert.equal(Object.keys(s.records.events).length, 0);
  s.records.notebooks[p.notebookId] = {};
  assert.throws(() => s.capture(caller, p, now), /ENTITY_NOT_FOUND/);
});
test('语境范围与来源非法时不写入业务资料', () => {
  for (const change of [
    (p) => {
      p.data.occurrenceRanges = [{ start: 0, end: 99999 }];
    },
    (p) => {
      p.data.source.url = 'file:///private';
    },
    (p) => {
      p.data.source.url = 'not a URL';
    },
    (p) => {
      p.data.source.url = 'https://user:password@example.invalid';
    },
    (p) => {
      p.data.source.kind = 'clipboard';
    },
  ]) {
    const s = store(),
      p = params();
    change(p);
    assert.throws(() => s.capture(caller, p, now));
    assert.equal(s.records.revision, '0');
    assert.equal(Object.keys(s.records.events).length, 0);
  }
});
test('采集不能复活已回收词', () => {
  const s = store();
  s.records.words[wordKey(params().data.word)] = { deleted: true };
  assert.throws(() => s.capture(caller, params(), now), /ENTITY_DELETED/);
});
test('公共和自定义词身份保持稳定，不按拼写合并', () => {
  assert.notEqual(
    wordKey({ kind: 'dictionary', entryId: 'A' }),
    wordKey({ kind: 'dictionary', entryId: 'a' }),
  );
  assert.notEqual(
    wordKey({ kind: 'custom', customId: 'a' }),
    wordKey({ kind: 'custom', customId: 'b' }),
  );
  assert.equal(hash({ b: 2, a: 1 }), hash({ a: 1, b: 2 }));
  assert.throws(() => canonical(NaN), /INVALID_NUMBER/);
  assert.throws(() => canonical('\ud800'), /INVALID_UNICODE/);
});
test('连接和临时断线都冻结旧管理页写入；未知操作不转投独立库', () => {
  const r = new WorkspaceRouter(['A']);
  r.begin();
  r.bind(owner);
  assert.throws(() => r.saveLocal('管理页旧写入'), /OWNER_NOT_WRITABLE/);
  const context = r.send('m1', params());
  r.lostConnection();
  assert.throws(() => r.send('m2', params()), /OWNER_NOT_WRITABLE/);
  r.restoreIndependent();
  assert.equal(r.receive(context, { saved: true }), false);
  assert.deepEqual(r.localData, ['A']);
  assert.equal(r.recovery.length, 1);
});
test('归档期间账号与同步停止，恢复独立不恢复登录和同步', () => {
  const r = new WorkspaceRouter(['A'], 'account-A');
  r.account = { token: 'example-local-secret' };
  r.syncEnabled = true;
  r.begin();
  r.bind(owner);
  const snapshot = r.snapshot();
  assert(!JSON.stringify(snapshot).includes('example-local-secret'));
  const restarted = new WorkspaceRouter(null, null, snapshot);
  assert.equal(restarted.frozen, true);
  restarted.restoreIndependent();
  assert.equal(restarted.account, null);
  assert.equal(restarted.syncEnabled, false);
  assert.equal(restarted.localBinding, 'account-A');
});
test('准备期间失败恢复 A，但不恢复已经退出的账号', () => {
  const r = new WorkspaceRouter(['A']);
  r.account = 'account-A';
  r.begin();
  r.restoreIndependent();
  assert.deepEqual(r.localData, ['A']);
  assert.equal(r.account, null);
  r.saveLocal('独立新增');
});
test('重连不能静默替换桌面身份，旧响应只进原归属恢复记录', () => {
  const r = new WorkspaceRouter(['A']);
  r.begin();
  r.bind(owner);
  const request = r.send('m1', params());
  r.lostConnection();
  assert.throws(() => r.bind({ ...owner, workspaceId: 'other' }), /OWNER_CHANGED/);
  r.bind(owner);
  assert.equal(r.receive(request, { saved: true }), false);
  assert.equal(r.recovery[0].context.owner.workspaceId, owner.workspaceId);
});
