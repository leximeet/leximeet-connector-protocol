'use strict';

// 契约摘要覆盖规范文件；不包含自身、样例或生成摘要，避免摘要自引用。
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { canonical } = require('./reference.cjs');
const root = path.resolve(__dirname, '..');
const read = (name) => JSON.parse(fs.readFileSync(path.join(root, name), 'utf8'));
const digest = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');
// 只包含已冻结的规范物料。维护、贡献、发布等说明不参与协商身份，避免新增说明导致消费者失配。
// 新增规范时必须明确修改此清单、版本策略和契约测试，不能通过遍历 docs 隐式扩张。
const normativeFiles = Object.freeze([
  'docs/extensions/browser.md',
  'docs/共享数据模型.md',
  'docs/兼容与迭代.md',
  'docs/双向宿主能力.md',
  'docs/实现与验收.md',
  'docs/接口规范.md',
  'docs/架构与接入.md',
  'docs/自动发现与连接邀请.md',
  'docs/连接与恢复.md',
  'docs/配对与契约身份.md',
  'extensions.json',
  'host-methods.json',
  'methods.json',
  'schemas/browser-host.v1.schema.json',
  'schemas/desktop-api.v1.schema.json',
  'schemas/dictionary-entry.v2.schema.json',
  'schemas/reading-domain.v1.schema.json',
]);

function manifest(
  configuration = read('contract.json'),
  load = (name) => fs.readFileSync(path.join(root, name)),
) {
  const { contractDigest: _excludedDigest, ...configurationWithoutDigest } = configuration;
  return {
    manifestVersion: 1,
    algorithm: 'sha256-jcs-manifest/1',
    contractVersion: configuration.packageVersion,
    configurationSha256: digest(Buffer.from(canonical(configurationWithoutDigest), 'utf8')),
    files: normativeFiles.map((name) => ({ path: name, sha256: digest(load(name)) })),
  };
}
function compute(configuration, load) {
  const value = manifest(configuration, load);
  return { manifest: value, digest: digest(Buffer.from(canonical(value), 'utf8')) };
}
if (require.main === module) {
  const value = compute();
  if (process.argv.includes('--write')) {
    fs.writeFileSync(
      path.join(root, 'contract-manifest.json'),
      JSON.stringify(value.manifest, null, 2) + '\n',
    );
    const configuration = read('contract.json');
    configuration.contractDigest = value.digest;
    fs.writeFileSync(
      path.join(root, 'contract.json'),
      JSON.stringify(configuration, null, 2) + '\n',
    );
    const fixtures = read('fixtures/contracts.json');
    for (const fixture of fixtures) {
      if (fixture.value.method !== 'hello') continue;
      const target = fixture.schema === 'Request' ? fixture.value.params : fixture.value.result;
      // 缺字段的反例保持缺失，不能因为生成摘要而变成正例。
      if (target && Object.hasOwn(target, 'contractDigest')) target.contractDigest = value.digest;
    }
    fs.writeFileSync(
      path.join(root, 'fixtures/contracts.json'),
      JSON.stringify(fixtures, null, 2) + '\n',
    );
  }
  console.log(value.digest);
}
module.exports = { normativeFiles, manifest, compute };
