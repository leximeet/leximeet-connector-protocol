'use strict';

// 无网络的合同辅助函数；不作为应用运行时依赖。
const { createHash } = require('node:crypto');
const copy = (value) => structuredClone(value);
function fail(code) {
  const error = new Error(code);
  error.code = code;
  throw error;
}
function validUnicode(value) {
  for (let i = 0; i < value.length; i++) {
    const n = value.charCodeAt(i);
    if (n >= 0xd800 && n <= 0xdbff) {
      const next = value.charCodeAt(++i);
      if (!(next >= 0xdc00 && next <= 0xdfff)) fail('INVALID_UNICODE');
    } else if (n >= 0xdc00 && n <= 0xdfff) fail('INVALID_UNICODE');
  }
}
function canonical(value) {
  if (typeof value === 'string') {
    validUnicode(value);
    return JSON.stringify(value);
  }
  if (typeof value === 'number' && !Number.isFinite(value)) fail('INVALID_NUMBER');
  if (value === null || ['number', 'boolean'].includes(typeof value)) return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (value && typeof value === 'object')
    return (
      '{' +
      Object.keys(value)
        .sort()
        .map((k) => canonical(k) + ':' + canonical(value[k]))
        .join(',') +
      '}'
    );
  fail('INVALID_JSON_VALUE');
}
const hash = (value) => createHash('sha256').update(canonical(value), 'utf8').digest('hex');
function wordKey(word) {
  if (word.kind === 'dictionary') return 'dict:' + word.entryId;
  if (word.kind === 'custom') return 'custom:' + word.customId;
  fail('UNKNOWN_WORD_KIND');
}
function studyDay(at, timeZone) {
  if (timeZone !== 'UTC' && !timeZone.includes('/')) fail('INVALID_TIME_ZONE');
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(new Date(at));
  const get = (key) => parts.find((x) => x.type === key).value;
  return `${get('year')}-${get('month')}-${get('day')}`;
}
function validateRanges(text, ranges, surface) {
  validUnicode(text);
  const boundary = (i) =>
    i > 0 &&
    i < text.length &&
    text.charCodeAt(i - 1) >= 0xd800 &&
    text.charCodeAt(i - 1) <= 0xdbff &&
    text.charCodeAt(i) >= 0xdc00 &&
    text.charCodeAt(i) <= 0xdfff;
  for (const { start, end } of ranges) {
    if (
      start < 0 ||
      end <= start ||
      end > text.length ||
      boundary(start) ||
      boundary(end) ||
      text.slice(start, end) !== surface
    )
      fail('INVALID_OCCURRENCE_RANGE');
  }
}
function validateFact(type, data) {
  if (type === 'encounter') {
    validateRanges(data.originalSentence, data.occurrenceRanges, data.surface);
    validateRanges(data.savedExcerpt, data.excerptRanges, data.surface);
    if (data.source.kind === 'web') {
      let url;
      try {
        url = new URL(data.source.url);
      } catch {
        fail('INVALID_SOURCE_URL');
      }
      if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.hash)
        fail('INVALID_SOURCE_URL');
    } else if (data.source.url !== null) fail('INVALID_SOURCE_URL');
    studyDay(data.occurredAt, data.timeZone);
  }
  if (type === 'word' && data.word && wordKey(data.word) === '') fail('INVALID_WORD_KEY');
}
module.exports = { canonical, hash, wordKey, studyDay, validateRanges, validateFact };
