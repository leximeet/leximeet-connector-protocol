'use strict';

// 离线验证本机合同；不连接应用、个人资料或远程 Schema URL。
const fs = require('node:fs'),
  path = require('node:path'),
  crypto = require('node:crypto');
const assert = require('node:assert/strict');
const Ajv2020 = require('ajv/dist/2020').default;
const root = path.resolve(__dirname, '..');
const read = (name) => JSON.parse(fs.readFileSync(path.join(root, name), 'utf8'));
const digest = (name) =>
  crypto
    .createHash('sha256')
    .update(fs.readFileSync(path.join(root, name)))
    .digest('hex');
const ajv = new Ajv2020({
  strict: true,
  allowUnionTypes: true,
  allErrors: true,
  coerceTypes: false,
  useDefaults: false,
  removeAdditional: false,
});
require('ajv-formats')(ajv);
const schemas = fs.readdirSync(path.join(root, 'schemas')).filter((n) => n.endsWith('.json'));
for (const file of schemas) ajv.addSchema(read('schemas/' + file));
let definitions = 0;
for (const file of schemas) {
  const schema = read('schemas/' + file);
  assert(ajv.getSchema(schema.$id), '根 Schema 无法离线编译');
  for (const name of Object.keys(schema.$defs || {})) {
    assert(ajv.getSchema(schema.$id + '#/$defs/' + name), name + ' 无法编译');
    definitions++;
  }
}
const config = read('contract.json'),
  methods = read('methods.json'),
  host = read('host-methods.json');
assert.equal(config.packageVersion, '1.0.0');
assert.equal(config.apiVersion, '1.0.0');
assert.equal(config.status, 'release-preparation');
assert.equal(config.runtimeImplemented, false);
assert.equal(config.jointAcceptancePassed, false);
assert.equal(config.preReleaseCompatibility, 'none');
assert.equal(config.releasedDataPolicy, 'preserve-from-application-1.0.0');
assert.equal(config.domainSha256, digest(config.domainSchema));
assert.equal(config.connectionPolicy.dataTransfer, 'none');
assert.equal(config.connectionPolicy.independentAccount, 'signed-out');
assert.equal(config.connectionPolicy.cloudSyncOwner, 'desktop');
assert.deepEqual(config.connectionPolicy.settings, ['disconnect']);
assert(!config.supportedProfiles && !config.mergeProfileId && !config.learningRuleVersion);
assert(
  !fs.existsSync(path.join(root, 'schemas/domain.v1.schema.json')),
  '本机仓不再携带全量同步模型',
);
const shared = read('shared-manifest.json');
assert.equal(Object.keys(shared.sha256).length, 1);
for (const [name, hash] of Object.entries(shared.sha256)) assert.equal(digest(name), hash);
const identity = require('./contract-digest.cjs').compute(config);
assert.deepEqual(identity.manifest, read('contract-manifest.json'));
assert.equal(identity.digest, config.contractDigest);
assert.equal(read('package.json').version, config.packageVersion);
assert.equal(read('package-lock.json').version, config.packageVersion);
const primary = read('schemas/desktop-api.v1.schema.json'),
  browser = read('schemas/browser-host.v1.schema.json');
assert(!JSON.stringify(primary).includes('meaningSupplement'), '本机 API 不再提供个人释义');
assert.deepEqual(Object.keys(primary.$defs.EncounterInput.properties.annotation.properties), [
  'note',
]);
const cases = read('fixtures/contracts.json');
for (const fixture of cases) {
  const schema = fixture.schema.startsWith('Host') ? browser : primary;
  const validate = ajv.getSchema(schema.$id + '#/$defs/' + fixture.schema);
  assert(validate, '不存在的样例结构：' + fixture.schema);
  assert.equal(
    validate(fixture.value),
    fixture.valid,
    fixture.name + ': ' + ajv.errorsText(validate.errors),
  );
}
assert.equal(methods.length, 19);
assert.equal(methods.filter((m) => m.required).length, 16);
assert.equal(host.length, 7);
assert.equal(primary.$defs.Request.oneOf.length, methods.length);
assert.equal(new Set(methods.map((m) => m.method)).size, methods.length);
assert(
  !JSON.stringify(primary).match(/Attachment|Practice|StudyPlan|supportedProfiles/),
  '残留接管或远程学习模型',
);
const doc = fs.readFileSync(path.join(root, 'docs/接口规范.md'), 'utf8');
// 索引是开发者判断会话前置条件的入口，不能仅检查后文存在方法标题。
const methodIndex = doc.split('## 方法索引\n')[1]?.split('\n## ')[0] || '';
const indexed = methodIndex
  .split('\n')
  .filter((line) => /^\| [a-z][A-Za-z]+ \|/.test(line))
  .map((line) =>
    line
      .split('|')
      .slice(1, -1)
      .map((cell) => cell.trim()),
  );
assert.equal(indexed.length, methods.length, '方法索引必须包含全部方法且不重复');
assert.equal(new Set(indexed.map((row) => row[0])).size, methods.length, '方法索引有重复项');
for (const method of methods) {
  assert(doc.includes('### ' + method.method), '缺少方法说明：' + method.method);
  const row = indexed.find((entry) => entry[0] === method.method);
  assert(row, '方法索引缺少：' + method.method);
  assert.equal(row[1], method.required ? '必需' : '可选', method.method + ' 要求与方法表不同');
  assert.equal(row[2], method.capability, method.method + ' 能力与方法表不同');
  assert.equal(row[4], method.auth ? '需要' : '不需要', method.method + ' 会话前置与方法表不同');
  const section = doc.split('### ' + method.method + '\n')[1]?.split('\n### ')[0];
  for (const [, json] of (section || '').matchAll(/```json\n([\s\S]*?)\n```/g)) {
    const requestFixture = cases.find(
      (c) => c.valid && c.schema === 'Request' && c.value.method === method.method,
    );
    assert.deepEqual(
      JSON.parse(json),
      requestFixture.value.params,
      method.method + ' 文档参数示例与合同漂移',
    );
  }
  assert.equal(method.direction, 'client-to-desktop');
  assert.equal(method.required, config.requiredCapabilities.includes(method.capability));
  for (const schema of ['Request', 'Response'])
    assert(
      cases.some((c) => c.valid && c.schema === schema && c.value.method === method.method),
      '缺少正例',
    );
  const request = primary.$defs.Request.oneOf.find(
    (s) => s.properties.method.const === method.method,
  );
  assert.equal(request.required.includes('authorization'), method.auth);
  if (method.write) {
    const params = primary.$defs[method.method + 'Params'];
    for (const branch of params.oneOf || [params]) assert(branch.required.includes('mutationId'));
  }
}
for (const fixture of cases.filter((c) => c.valid && c.value.method === 'hello')) {
  const payload = fixture.schema === 'Request' ? fixture.value.params : fixture.value.result;
  assert.equal(payload.contractVersion, config.packageVersion);
  assert.equal(payload.contractDigest, config.contractDigest);
}
const extensions = read('extensions.json');
// 样例还必须表达可实际对接的语义，不能仅靠宽松字符串字段通过结构校验。
const sample = (name) => cases.find((c) => c.name === name).value;
for (const name of ['pair', 'resumeSession', 'renewSession']) {
  const result = sample(name + '-response').result;
  assert(
    ['library:read', 'capture:write', 'navigation:open'].every((scope) =>
      result.scopes.includes(scope),
    ),
  );
  assert(!result.scopes.some((scope) => /attachment|study|library:write/.test(scope)));
  assert(Date.parse(result.readLeaseUntil) <= Date.parse(result.expiresAt));
  assert.equal(result.pairingId, result.owner.pairingId);
}
const registration = sample('registerHost-response').result;
assert(
  registration.capabilities.every((cap) =>
    sample('registerHost-request').params.capabilities.includes(cap),
  ),
);
assert(
  registration.capabilities.every((cap) =>
    extensions.find((e) => e.id === registration.extensionId).capabilities.includes(cap),
  ),
);
const capture = sample('recordEncounter-request').params;
const receipt = sample('recordEncounter-response').result;
assert.equal(receipt.entity.entityId, capture.eventId);
for (const [key, value] of Object.entries(capture.data))
  assert.deepEqual(receipt.entity.data[key], value);
assert.equal(receipt.entity.data.origin.clientKind, 'desktop');
assert.deepEqual(sample('getOperation-response').result.result, receipt);
assert.equal(sample('getWorkspace-response').result.account.source, 'desktop');
const match = sample('matchWords-request').params;
assert.equal(
  sample('matchWords-response').result.results.length,
  (match.words || match.tokens).length,
);
const publicEntry = sample('getPublicEntry-response').result.entry;
assert.equal(sample('getPublicEntry-request').params.entryId, publicEntry.entry_id);
for (const c of cases.filter((c) => c.valid))
  assert(Buffer.byteLength(JSON.stringify(c.value), 'utf8') <= config.browserBinding.maxFrameBytes);
for (const item of host) {
  assert.equal(item.requiredForCore, false);
  assert(extensions.some((e) => e.id === item.extensionId && !e.requiredForCore));
  for (const schema of ['HostRequest', 'HostResponse'])
    assert(cases.some((c) => c.valid && c.schema === schema && c.value.method === item.method));
}
function markdown(directory) {
  return fs.readdirSync(path.join(root, directory), { withFileTypes: true }).flatMap((entry) => {
    if (entry.name === '.chat') return [];
    const name = path.join(directory, entry.name);
    return entry.isDirectory() ? markdown(name) : name.endsWith('.md') ? [name] : [];
  });
}
let diagrams = 0;
for (const name of ['README.md', 'CONTRIBUTING.md', 'CHANGELOG.md', ...markdown('docs')]) {
  const text = fs.readFileSync(path.join(root, name), 'utf8');
  assert(
    !/"contractDigest"\s*:\s*"[0-9a-f]{64}"/.test(text),
    name + ' 不应内嵌会造成自引用或过期的合同摘要',
  );
  assert.equal((text.match(/^```/gm) || []).length % 2, 0, name + ' 代码围栏不完整');
  assert(!text.includes('/Users/') && !text.includes('docs/.chat/'), '公共文档出现私人路径');
  for (const [, target] of text.matchAll(/\[[^\]]+\]\(([^)]+)\)/g)) {
    if (/^[a-z]+:|^#/.test(target)) continue;
    const relative = target.split('#')[0];
    if (relative)
      assert(
        fs.existsSync(path.resolve(path.dirname(path.join(root, name)), relative)),
        name + ' 链接失效：' + target,
      );
  }
  diagrams += (text.match(/```mermaid/g) || []).length;
}
assert(diagrams >= 6, '开发者图解覆盖不足');
console.log(
  JSON.stringify({
    schemas: schemas.length,
    definitions,
    structuralCases: cases.length,
    desktopMethods: methods.length,
    requiredMethods: 16,
    optionalHostMethods: host.length,
    diagrams,
    offline: true,
    runtimeIntegrationVerified: false,
  }),
);
