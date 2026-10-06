'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { PairingRegistry, negotiate } = require('../tools/session-reference.cjs');
const config = require('../contract.json');
const { compute } = require('../tools/contract-digest.cjs');
const identity = {
  desktopInstanceId: 'desktop',
  workspaceId: 'workspace',
  generation: 'generation',
  authorizationEpoch: '1',
  clientInstanceId: 'browser',
};
const origin = 'test-extension',
  connection = 'connection-1',
  now = '2026-10-03T00:00:00.000Z';
const pair = (registry) =>
  registry.pair(origin, identity, ['library:read', 'capture:write'], connection, now);
test('配对直接提供已授权会话，没有 attachment 前置条件', () => {
  const registry = new PairingRegistry(),
    result = pair(registry);
  assert(!('attachmentId' in result));
  assert(!('mode' in result));
  assert.equal(
    registry.authorize(origin, result.authorization, connection, identity, now).owner.pairingId,
    result.pairingId,
  );
});
test('重启后以同一设备信任恢复，注册表不保存明文 token', () => {
  const registry = new PairingRegistry(),
    result = pair(registry),
    snapshot = registry.snapshot();
  const raw = JSON.stringify(snapshot);
  assert(!raw.includes(result.pairingCredential.pairingToken));
  assert(!raw.includes(result.authorization.sessionToken));
  const resumed = new PairingRegistry(snapshot).resume(
    origin,
    result.pairingCredential,
    identity,
    'connection-2',
    now,
  );
  assert.equal(resumed.pairingId, result.pairingId);
  assert.notEqual(resumed.authorization.sessionId, result.authorization.sessionId);
});
test('会话绑定可信来源和实际连接，不接受跨连接转发', () => {
  const registry = new PairingRegistry(),
    result = pair(registry);
  assert.throws(
    () => registry.authorize('other-origin', result.authorization, connection, identity, now),
    /UNAUTHORIZED/,
  );
  assert.throws(
    () => registry.authorize(origin, result.authorization, 'connection-2', identity, now),
    /STALE_CONNECTION/,
  );
});
test('账号授权代次、工作区或数据库世代改变必须停止恢复', () => {
  const registry = new PairingRegistry(),
    result = pair(registry);
  for (const field of ['desktopInstanceId', 'workspaceId', 'generation', 'authorizationEpoch']) {
    const changed = { ...identity, [field]: 'changed' };
    assert.throws(
      () => registry.resume(origin, result.pairingCredential, changed, 'connection-2', now),
      /GENERATION_MISMATCH/,
    );
    assert.throws(
      () => registry.authorize(origin, result.authorization, connection, changed, now),
      /GENERATION_MISMATCH/,
    );
  }
});
test('续发不提前废止在途旧会话，原过期时间仍生效', () => {
  const registry = new PairingRegistry(),
    first = pair(registry);
  const second = registry.renew(
    origin,
    first.authorization,
    connection,
    identity,
    '2026-10-03T01:00:00.000Z',
  );
  registry.authorize(origin, first.authorization, connection, identity, '2026-10-03T02:00:00.000Z');
  assert.throws(
    () =>
      registry.authorize(
        origin,
        first.authorization,
        connection,
        identity,
        '2026-10-04T00:00:00.000Z',
      ),
    /SESSION_EXPIRED/,
  );
  registry.authorize(
    origin,
    second.authorization,
    connection,
    identity,
    '2026-10-04T00:00:00.000Z',
  );
});
test('明确断开结束配对全部会话，保留信任但禁止自动恢复', () => {
  const registry = new PairingRegistry(),
    first = pair(registry);
  const second = registry.renew(origin, first.authorization, connection, identity, now);
  registry.disconnect(origin, second.authorization, connection, identity, now);
  for (const result of [first, second])
    assert.throws(
      () => registry.authorize(origin, result.authorization, connection, identity, now),
      /UNAUTHORIZED/,
    );
  assert.throws(
    () => registry.resume(origin, first.pairingCredential, identity, 'connection-2', now),
    /CONNECTION_ENDED/,
  );
});
test('撤销配对后旧会话和配对凭据都失效，不能撤销别的配对', () => {
  const registry = new PairingRegistry(),
    result = pair(registry);
  assert.throws(
    () => registry.revoke(origin, result.authorization, connection, identity, 'other-pairing', now),
    /FORBIDDEN/,
  );
  registry.revoke(origin, result.authorization, connection, identity, result.pairingId, now);
  assert.throws(
    () => registry.resume(origin, result.pairingCredential, identity, 'connection-2', now),
    /PAIRING_REVOKED/,
  );
  assert.throws(
    () => registry.authorize(origin, result.authorization, connection, identity, now),
    /UNAUTHORIZED/,
  );
});
const local = {
  minApiVersion: '1.0.0',
  contractVersion: '1.0.0',
  contractDigest: 'A',
  requiredCapabilities: config.requiredCapabilities,
};
const peer = {
  apiVersion: '1.1.0',
  contractVersion: '1.1.0',
  contractDigest: 'B',
  capabilities: [...config.requiredCapabilities, 'ide.future/1'],
};
test('正式 1.x 新增可选宿主能力和摘要变化不阻止旧客户端连接', () => {
  assert(negotiate(local, peer));
  assert(negotiate(local, { ...peer, capabilities: config.requiredCapabilities }));
});
test('缺必需能力或不兼容 API 版本明确拒绝', () => {
  assert.throws(() => negotiate(local, { ...peer, capabilities: [] }), /CAPABILITY_UNAVAILABLE/);
  assert.throws(() => negotiate(local, { ...peer, apiVersion: '2.0.0' }), /UNSUPPORTED_VERSION/);
});
test('未来预发布联调固定候选身份，不影响正式版本协商', () => {
  const candidateVersion = '1.1.0-rc.1';
  const client = {
    ...local,
    contractVersion: candidateVersion,
    contractDigest: config.contractDigest,
  };
  const server = {
    ...peer,
    contractVersion: candidateVersion,
    contractDigest: config.contractDigest,
  };
  assert(negotiate(client, server));
  assert.throws(
    () => negotiate(client, { ...server, contractDigest: 'other' }),
    /CONTRACT_MISMATCH/,
  );
});
test('生成摘要覆盖公共规范与扩展文件，摘要自身不参与自引用', () => {
  const result = compute(config);
  assert.equal(result.digest, config.contractDigest);
  assert(result.manifest.files.some((x) => x.path === 'docs/extensions/browser.md'));
  assert(!result.manifest.files.some((x) => x.path === 'contract-manifest.json'));
});
test('缓存租期不超过会话期限，断开后不能续租', () => {
  const r = new PairingRegistry(),
    p = pair(r);
  assert.equal(
    r.readLease(origin, p.authorization, connection, identity, '2026-10-03T23:59:50.000Z'),
    p.expiresAt,
  );
  r.disconnect(origin, p.authorization, connection, identity, now);
  assert.throws(
    () => r.readLease(origin, p.authorization, connection, identity, now),
    /UNAUTHORIZED/,
  );
});
