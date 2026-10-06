'use strict';
// 验证固定契约的控制边界；生产授权事务另由应用 Core 测试证明。
const test = require('node:test');
const assert = require('node:assert/strict');
const Ajv = require('ajv/dist/2020').default;
const ajv = new Ajv({ strict: true, allErrors: true });
require('ajv-formats')(ajv);
for (const name of ['desktop-api.v1', 'reading-domain.v1', 'dictionary-entry.v2'])
  ajv.addSchema(require('../schemas/' + name + '.schema.json'));
const validate = (name) =>
  ajv.getSchema('https://leximeet.github.io/contracts/desktop-api.v1.schema.json#/$defs/' + name);
const id = '11111111-1111-4111-8111-111111111111';
test('hello发现必须标识安装实例和安全名称，不能夹带资料', () => {
  const fixture = require('../fixtures/contracts.json').find((x) => x.name === 'hello-request')
    .value.params;
  assert(validate('helloParams')(fixture));
  for (const key of ['clientInstanceId', 'displayName']) {
    const p = structuredClone(fixture);
    delete p[key];
    assert(!validate('helloParams')(p));
  }
  assert(!validate('helloParams')({ ...fixture, localWords: [] }));
});
test('pair仅接受秘密邀请票据，不再支持手输配对码或资料导入', () => {
  const p = { clientInstanceId: id, invitationId: id, invitationToken: 'x'.repeat(43) };
  assert(validate('pairParams')(p));
  assert(!validate('pairParams')({ ...p, pairingCode: '123456' }));
  assert(!validate('pairParams')({ ...p, archive: {} }));
});
test('取消邀请必须标明同一邀请，状态查询不能夹带业务写入', () => {
  assert(validate('requestConnectionParams')({ clientInstanceId: id, action: 'request' }));
  assert(
    validate('requestConnectionParams')({
      clientInstanceId: id,
      action: 'cancel',
      invitationId: id,
    }),
  );
  assert(!validate('requestConnectionParams')({ clientInstanceId: id, action: 'cancel' }));
  assert(!validate('getConnectionStatusParams')({ clientInstanceId: id, words: [] }));
});
test('明确断开、撤权和已接受邀请有可区分的控制状态', () => {
  for (const connectionState of ['disconnected', 'revoked'])
    assert(
      validate('ConnectionStatus')({
        desktopInstanceId: id,
        displayName: 'Desktop',
        connectionState,
        invitationState: 'accepted',
        invitation: null,
      }),
    );
  assert(
    !validate('ConnectionStatus')({
      desktopInstanceId: id,
      displayName: 'Desktop',
      connectionState: 'offline',
      invitationState: 'none',
      invitation: null,
    }),
  );
});
