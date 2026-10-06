'use strict';

// 交付身份只由显式规范清单决定；维护文档不能悄悄扩大消费者合同。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { compute, normativeFiles } = require('../tools/contract-digest.cjs');
const root = path.resolve(__dirname, '..');
const configuration = require('../contract.json');

test('冻结 17 项规范并保持清单唯一、有序', () => {
  assert.equal(normativeFiles.length, 17);
  assert.equal(new Set(normativeFiles).size, normativeFiles.length);
  assert.deepEqual([...normativeFiles].sort(), [...normativeFiles]);
  assert.equal(Object.isFrozen(normativeFiles), true);
  assert.equal(compute(configuration).digest, configuration.contractDigest);
});

test('新增非规范 docs 不改变交付身份', () => {
  const filename = path.join(root, 'docs', `maintenance-test-${process.pid}.md`);
  const before = compute(configuration);
  try {
    fs.writeFileSync(filename, '# 维护说明\n不定义协议行为。\n', { flag: 'wx' });
    assert.deepEqual(compute(configuration), before);
    fs.appendFileSync(filename, '\n另一条维护说明。\n');
    assert.deepEqual(compute(configuration), before);
  } finally {
    fs.rmSync(filename, { force: true });
  }
});

test('任一规范原始字节变化都会改变摘要', () => {
  const before = compute(configuration);
  for (const modified of normativeFiles) {
    const result = compute(configuration, (filename) => {
      const bytes = fs.readFileSync(path.join(root, filename));
      return filename === modified ? Buffer.concat([bytes, Buffer.from('\n')]) : bytes;
    });
    assert.notEqual(result.digest, before.digest, modified);
  }
});
