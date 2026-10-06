'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const { compute, normativeFiles } = require('./contract-digest.cjs');

const root = path.resolve(__dirname, '..');
const read = (directory, file) => JSON.parse(fs.readFileSync(path.join(directory, file), 'utf8'));
const sha = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const git = (directory, ...args) =>
  execFileSync('git', ['--no-replace-objects', '-C', directory, ...args], {
    encoding: 'utf8',
    maxBuffer: 8 * 1024 * 1024,
  }).trim();

/** 归档前核对正式版本和当前规范，不能只信任写在 contract.json 中的摘要。 */
function validateContract(directory) {
  const configuration = read(directory, 'contract.json');
  const manifest = read(directory, 'contract-manifest.json');
  const pkg = read(directory, 'package.json');
  const lock = read(directory, 'package-lock.json');
  if (
    !/^\d+\.\d+\.\d+$/.test(configuration.packageVersion) ||
    configuration.apiVersion !== configuration.packageVersion ||
    pkg.version !== configuration.packageVersion ||
    lock.version !== pkg.version
  )
    throw new Error('源码、锁文件与正式合同版本不一致。');
  const actual = compute(configuration, (file) => fs.readFileSync(path.join(directory, file)));
  if (
    actual.digest !== configuration.contractDigest ||
    JSON.stringify(actual.manifest) !== JSON.stringify(manifest)
  )
    throw new Error('规范字节或生成摘要不一致，拒绝归档。');
  return configuration;
}

/** 使用精确 Git 提交归档，依赖缓存、个人环境和未提交文件不会混入发行物。 */
function packageRelease(directory = root, outputDirectory) {
  const realRoot = fs.realpathSync(directory);
  if (fs.realpathSync(git(realRoot, 'rev-parse', '--show-toplevel')) !== realRoot)
    throw new Error('发行来源必须是本协议仓库，不能借用上级仓库身份。');
  if (git(realRoot, 'status', '--porcelain', '--untracked-files=normal'))
    throw new Error('发行归档要求干净工作树，请先提交本轮改动。');
  const configuration = validateContract(realRoot);
  const commit = git(realRoot, 'rev-parse', 'HEAD');
  const version = configuration.packageVersion;
  const stamp = new Date().toISOString().replace(/[-:.]/g, '');
  const output = path.resolve(
    outputDirectory || path.join(realRoot, '.runtime', 'release', version, stamp),
  );
  fs.mkdirSync(path.dirname(output), { recursive: true });
  // 即使同名目录为空也不覆盖，保留前一份发行物与排障证据。
  fs.mkdirSync(output);
  const source = `leximeet-connector-protocol-${version}-source.tar.gz`;
  const contract = `leximeet-connector-protocol-${version}-contract.tar.gz`;
  const materialFiles = [
    'LICENSE',
    'contract.json',
    'contract-manifest.json',
    'shared-manifest.json',
    'fixtures/contracts.json',
    ...normativeFiles,
  ];
  for (const [file, prefix, selected] of [
    [source, `leximeet-connector-protocol-${version}/`, []],
    [contract, `lmcp-${version}/`, materialFiles],
  ])
    git(
      realRoot,
      'archive',
      '--format=tar.gz',
      `--prefix=${prefix}`,
      `--output=${path.join(output, file)}`,
      commit,
      '--',
      ...selected,
    );
  if (
    git(realRoot, 'rev-parse', 'HEAD') !== commit ||
    git(realRoot, 'status', '--porcelain', '--untracked-files=normal')
  )
    throw new Error('归档期间源码发生变化，请从同一干净提交重新交付。');
  const artifacts = [source, contract].map((file) => ({
    file,
    bytes: fs.statSync(path.join(output, file)).size,
    sha256: sha(path.join(output, file)),
  }));
  const metadata = {
    format: 'leximeet.lmcp-release/1',
    version,
    // 软件发行标签与正式版本完全一致，不沿用旧候选的 v 前缀。
    releaseTag: version,
    contractDigest: configuration.contractDigest,
    domainSha256: configuration.domainSha256,
    normativeFiles: normativeFiles.length,
    source: { repository: 'https://github.com/leximeet/leximeet-connector-protocol', commit },
    artifacts,
  };
  fs.writeFileSync(
    path.join(output, 'RELEASE-MANIFEST.json'),
    JSON.stringify(metadata, null, 2) + '\n',
  );
  fs.writeFileSync(
    path.join(output, 'SHA256SUMS'),
    artifacts.map((item) => `${item.sha256}  ${item.file}\n`).join(''),
  );
  verifyRelease(output, realRoot);
  return { directory: output, ...metadata };
}

/** 只校验已生成的包，不连接 GitHub，也不把校验成功误报为发布成功。 */
function verifyRelease(directory, repository = root) {
  const metadata = read(directory, 'RELEASE-MANIFEST.json');
  const current = validateContract(repository);
  const expected = [
    `leximeet-connector-protocol-${current.packageVersion}-source.tar.gz`,
    `leximeet-connector-protocol-${current.packageVersion}-contract.tar.gz`,
  ];
  if (
    metadata.format !== 'leximeet.lmcp-release/1' ||
    metadata.version !== current.packageVersion ||
    metadata.releaseTag !== current.packageVersion ||
    metadata.contractDigest !== current.contractDigest ||
    metadata.domainSha256 !== current.domainSha256 ||
    metadata.normativeFiles !== normativeFiles.length ||
    !/^[0-9a-f]{40}$/.test(metadata.source?.commit || '') ||
    metadata.source?.repository !== 'https://github.com/leximeet/leximeet-connector-protocol' ||
    JSON.stringify(metadata.artifacts?.map((item) => item.file)) !== JSON.stringify(expected)
  )
    throw new Error('发行清单的版本、身份、来源或文件列表无效。');
  for (const item of metadata.artifacts) {
    const file = path.join(directory, item.file);
    if (fs.statSync(file).size !== item.bytes || sha(file) !== item.sha256)
      throw new Error(`发行文件长度或 SHA-256 不一致：${item.file}`);
  }
  const sums = metadata.artifacts.map((item) => `${item.sha256}  ${item.file}\n`).join('');
  if (fs.readFileSync(path.join(directory, 'SHA256SUMS'), 'utf8') !== sums)
    throw new Error('SHA256SUMS 与发行清单不一致。');
  return metadata;
}

if (require.main === module) {
  try {
    const verify = process.argv[2] === '--verify';
    if (verify && !process.argv[3]) throw new Error('用法：npm run verify:release -- 发行目录');
    if (!verify && process.argv.length > 3)
      throw new Error('用法：npm run package:release -- [新的输出目录]');
    const result = verify
      ? verifyRelease(path.resolve(process.argv[3]))
      : packageRelease(root, process.argv[2]);
    console.log(JSON.stringify(result, null, 2));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}

module.exports = { validateContract, packageRelease, verifyRelease };
