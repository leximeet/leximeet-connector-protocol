'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { normativeFiles } = require('../tools/contract-digest.cjs');
const { packageRelease, validateContract, verifyRelease } = require('../tools/package-release.cjs');
const source = path.resolve(__dirname, '..');

/** 每个用例使用自己的临时 Git 仓库，不写开发仓的索引、分支或用户资料。 */
function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'leximeet-contract-release-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const files = [
    'LICENSE',
    'contract.json',
    'contract-manifest.json',
    'shared-manifest.json',
    'fixtures/contracts.json',
    'package.json',
    'package-lock.json',
    ...normativeFiles,
  ];
  for (const file of files) {
    fs.mkdirSync(path.dirname(path.join(directory, file)), { recursive: true });
    fs.copyFileSync(path.join(source, file), path.join(directory, file));
  }
  fs.writeFileSync(path.join(directory, '.gitignore'), '.runtime/\nnode_modules/\n.env\n');
  const git = (...args) =>
    execFileSync('git', ['-C', directory, ...args], { encoding: 'utf8' }).trim();
  git('init', '--quiet');
  git('add', '.');
  git(
    '-c',
    'user.name=Release Test',
    '-c',
    'user.email=release@example.invalid',
    'commit',
    '--quiet',
    '-m',
    '隔离样例',
  );
  return { directory, git };
}

test('正式归档记录精确提交和17项规范，忽略缓存与个人环境', (t) => {
  const f = fixture(t);
  fs.mkdirSync(path.join(f.directory, 'node_modules'));
  fs.writeFileSync(path.join(f.directory, 'node_modules', 'private.txt'), '不得进入发行物');
  fs.writeFileSync(path.join(f.directory, '.env'), 'SYNTHETIC_PRIVATE_SENTINEL=not-a-secret');
  const result = packageRelease(f.directory);
  assert.equal(result.source.commit, f.git('rev-parse', 'HEAD'));
  assert.equal(result.releaseTag, '1.0.0');
  assert.equal(result.normativeFiles, 17);
  assert.equal(result.artifacts.length, 2);
  assert.equal(verifyRelease(result.directory, f.directory).contractDigest, result.contractDigest);
  const names = execFileSync(
    'tar',
    ['-tzf', path.join(result.directory, result.artifacts[0].file)],
    { encoding: 'utf8' },
  );
  assert(names.includes('/package-lock.json'));
  assert(
    !names.includes('node_modules/') && !names.includes('/.env') && !names.includes('/.runtime/'),
  );
});

test('未提交的源码或非忽略文件阻止发行，不悄悄归档旧提交', (t) => {
  const f = fixture(t);
  fs.appendFileSync(path.join(f.directory, 'LICENSE'), '\nchanged\n');
  assert.throws(() => packageRelease(f.directory), /干净工作树/);
  f.git('checkout', '--', 'LICENSE');
  fs.writeFileSync(path.join(f.directory, 'pending.txt'), '尚未提交');
  assert.throws(() => packageRelease(f.directory), /干净工作树/);
});

test('重复输出目录被拒绝，前一份发行归档不受影响', (t) => {
  const f = fixture(t);
  const result = packageRelease(f.directory);
  const before = fs.readFileSync(path.join(result.directory, 'SHA256SUMS'));
  assert.throws(() => packageRelease(f.directory, result.directory), /EEXIST/);
  assert.deepEqual(fs.readFileSync(path.join(result.directory, 'SHA256SUMS')), before);
});

test('摘要漂移或版本不一致在归档前被发现', (t) => {
  const f = fixture(t);
  fs.appendFileSync(path.join(f.directory, normativeFiles[0]), '\n');
  assert.throws(() => validateContract(f.directory), /规范字节/);
  f.git('checkout', '--', normativeFiles[0]);
  const pkg = JSON.parse(fs.readFileSync(path.join(f.directory, 'package.json')));
  pkg.version = '1.0.0-rc.1';
  fs.writeFileSync(path.join(f.directory, 'package.json'), JSON.stringify(pkg));
  assert.throws(() => validateContract(f.directory), /正式合同版本/);
});

test('发行物被改写或校验和被改写均不能通过核验', (t) => {
  const f = fixture(t);
  const first = packageRelease(f.directory);
  fs.appendFileSync(path.join(first.directory, first.artifacts[0].file), 'corrupted');
  assert.throws(() => verifyRelease(first.directory, f.directory), /长度或 SHA-256/);
  const second = packageRelease(f.directory);
  fs.writeFileSync(path.join(second.directory, 'SHA256SUMS'), 'incorrect\n');
  assert.throws(() => verifyRelease(second.directory, f.directory), /SHA256SUMS/);
});

test('发行清单不能引入任意路径或伪造另一个协议身份', (t) => {
  const f = fixture(t);
  const result = packageRelease(f.directory);
  const manifest = path.join(result.directory, 'RELEASE-MANIFEST.json');
  const value = JSON.parse(fs.readFileSync(manifest));
  value.artifacts[0].file = '../private-data.tar.gz';
  fs.writeFileSync(manifest, JSON.stringify(value));
  assert.throws(() => verifyRelease(result.directory, f.directory), /文件列表无效/);
  value.artifacts[0].file = result.artifacts[0].file;
  value.contractDigest = '0'.repeat(64);
  fs.writeFileSync(manifest, JSON.stringify(value));
  assert.throws(() => verifyRelease(result.directory, f.directory), /文件列表无效/);
});

test('发行清单标签必须等于正式版本，拒绝旧前缀、候选或缺失标签', (t) => {
  const f = fixture(t);
  const result = packageRelease(f.directory);
  const manifest = path.join(result.directory, 'RELEASE-MANIFEST.json');
  const value = JSON.parse(fs.readFileSync(manifest));
  for (const releaseTag of ['v1.0.0', '1.0.0-rc.1', '2.0.0', undefined]) {
    value.releaseTag = releaseTag;
    fs.writeFileSync(manifest, JSON.stringify(value));
    assert.throws(() => verifyRelease(result.directory, f.directory), /文件列表无效/);
  }
});
