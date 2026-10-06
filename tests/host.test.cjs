'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { HostReceiptJournal, hostGuard } = require('../tools/host-reference.cjs');
const now = '2026-10-03T00:00:00.000Z';
const owner = {
  pairingId: 'pair',
  desktopInstanceId: 'desktop',
  clientInstanceId: 'browser',
  workspaceId: 'workspace',
  generation: 'generation',
  authorizationEpoch: '1',
};
const grant = (id, capabilities = ['browser.open-source/1']) => ({
  id,
  token: 'example-token',
  owner,
  capabilities,
  expiresAt: '2026-10-03T00:10:00.000Z',
  authorizedPages: { page: 'v1' },
});
test('宿主动作同 ID 重试不重复执行，改载荷被拒绝', () => {
  const j = new HostReceiptJournal();
  j.register(grant('g1'));
  let opened = 0;
  const action = () => ({ opened: ++opened });
  const invoke = (params) =>
    j.execute('g1', 'example-token', 'i1', 'browser.openSource', params, now, action);
  invoke({ url: 'https://example.invalid/' });
  invoke({ url: 'https://example.invalid/' });
  assert.equal(opened, 1);
  assert.throws(() => invoke({ url: 'https://other.invalid/' }), /IDEMPOTENCY_KEY_REUSED/);
});
test('新授权只恢复同 owner 的旧回执，不重新执行原宿主动作', () => {
  const j = new HostReceiptJournal();
  j.register(grant('g1'));
  j.execute('g1', 'example-token', 'i1', 'browser.openSource', {}, now, () => ({ opened: true }));
  j.invalidate('g1');
  j.register(grant('g2'));
  assert.throws(
    () => j.execute('g2', 'example-token', 'i1', 'browser.openSource', {}, now, () => ({})),
    /OPERATION_RECOVERY_REQUIRED/,
  );
  const result = j.recover('g2', 'example-token', 'g1', 'i1', now);
  assert.equal(result.status, 'applied');
  assert.equal(result.contentStatus, 'available');
});
test('可选能力缺失和过期页面禁止执行', () => {
  const j = new HostReceiptJournal();
  j.register(grant('g1', ['browser.highlight/1']));
  assert.throws(
    () => j.execute('g1', 'example-token', 'i1', 'browser.openSource', {}, now, () => ({})),
    /CAPABILITY_UNAVAILABLE/,
  );
  assert.throws(
    () =>
      j.execute(
        'g1',
        'example-token',
        'i1',
        'browser.highlight',
        { pageHandle: 'page', documentRevision: 'v0' },
        now,
        () => ({}),
      ),
    /PAGE_STALE/,
  );
});
test('新授权收窄后仅返回状态摘要，不泄露旧选区内容', () => {
  const j = new HostReceiptJournal();
  j.register(grant('g1', ['browser.selection/1']));
  j.execute(
    'g1',
    'example-token',
    'i1',
    'browser.readSelection',
    { pageHandle: 'page', documentRevision: 'v1' },
    now,
    () => ({ text: 'private selection' }),
  );
  j.invalidate('g1');
  j.register(grant('g2', ['browser.open-source/1']));
  const result = j.recover('g2', 'example-token', 'g1', 'i1', now);
  assert.equal(result.receipt, null);
  assert.equal(result.contentStatus, 'not-authorized');
});
test('撤销整个配对后不能恢复任何宿主回执', () => {
  const j = new HostReceiptJournal();
  j.register(grant('g1'));
  j.execute('g1', 'example-token', 'i1', 'browser.openSource', {}, now, () => ({ opened: true }));
  j.revokeOwner(owner);
  assert.throws(() => j.recover('g1', 'example-token', 'g1', 'i1', now), /PAIRING_REVOKED/);
});
test('宿主请求拒绝旧连接、错误工作区和过期截止时间', () => {
  const g = {
    ...grant('g1', ['browser.highlight/1']),
    connectionId: 'c1',
    workspace: { workspaceId: 'w1', generation: 'v1' },
  };
  const request = {
    connectionId: 'c1',
    grantId: 'g1',
    grantToken: g.token,
    workspace: g.workspace,
    method: 'browser.highlight',
    params: { pageHandle: 'page', documentRevision: 'v1' },
    deadlineAt: '2026-10-03T00:00:15.000Z',
  };
  hostGuard(request, g, now);
  assert.throws(() => hostGuard({ ...request, connectionId: 'c0' }, g, now), /STALE_GRANT/);
  assert.throws(
    () => hostGuard({ ...request, workspace: { workspaceId: 'other' } }, g, now),
    /STALE_GRANT/,
  );
  assert.throws(() => hostGuard({ ...request, deadlineAt: now }, g, now), /DEADLINE_EXCEEDED/);
});
test('宿主授权更新使旧 grant 失效，持久参考快照不保存明文 token', () => {
  const j = new HostReceiptJournal();
  j.register(grant('g1'));
  j.register(grant('g2'));
  assert.throws(() => j.current('g1', 'example-token', now), /STALE_GRANT/);
  assert(!JSON.stringify(j.snapshot()).includes('example-token'));
});
