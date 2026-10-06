'use strict';

// 仅演示授权后的业务事务与回执，不能替代真实 Core/SQLite/Native Host 验收。
const { hash, wordKey, validateFact } = require('./reference.cjs');
const copy = (value) => structuredClone(value);
const fail = (code) => {
  throw Object.assign(new Error(code), { code });
};
class CaptureStore {
  constructor(identity, knownWords, writer) {
    this.identity = copy(identity);
    this.writer = copy(writer);
    this.knownWords = new Set(knownWords);
    this.records = { words: {}, events: {}, notebooks: {}, receipts: {}, revision: '0' };
  }
  check(caller, scope) {
    if (!caller.authorized || !caller.scopes.includes(scope)) fail('FORBIDDEN');
    for (const field of ['desktopInstanceId', 'workspaceId', 'generation', 'authorizationEpoch']) {
      if (caller.owner[field] !== this.identity[field]) fail('GENERATION_MISMATCH');
    }
  }
  key(caller, mutationId) {
    return hash({ owner: caller.owner, mutationId });
  }
  operation(caller, mutationId) {
    this.check(caller, 'capture:write');
    const saved = this.records.receipts[this.key(caller, mutationId)];
    return saved ? copy(saved.operation) : { mutationId, status: 'unknown' };
  }
  capture(caller, params, now, abortBeforeCommit = false) {
    // 身份与权限先于历史回执查询；撤权不能借幂等查询读取旧数据。
    this.check(caller, 'capture:write');
    const key = this.key(caller, params.mutationId),
      fingerprint = hash({ method: 'recordEncounter', params });
    const old = this.records.receipts[key];
    if (old) {
      if (old.fingerprint !== fingerprint) fail('IDEMPOTENCY_KEY_REUSED');
      if (old.operation.status === 'rejected') fail(old.operation.error.code);
      return copy(old.operation.result);
    }
    try {
      const next = copy(this.records),
        word = wordKey(params.data.word);
      if (params.data.word.kind === 'dictionary' && !this.knownWords.has(word) && !next.words[word])
        fail('RESOURCE_UNAVAILABLE');
      if (next.words[word]?.deleted) fail('ENTITY_DELETED');
      if (params.notebookId !== null && !next.notebooks[params.notebookId])
        fail('ENTITY_NOT_FOUND');
      const fact = {
        ...copy(params.data),
        occurredAt: now,
        timeZone: this.writer.timeZone,
        origin: { deviceId: this.writer.deviceId, clientKind: 'desktop' },
      };
      if (!['web', 'manual'].includes(fact.source.kind) || fact.collectionIntent !== 'collect')
        fail('INVALID_SOURCE_URL');
      validateFact('encounter', fact);
      const eventFingerprint = hash({
        eventId: params.eventId,
        data: params.data,
        notebookId: params.notebookId,
      });
      const previous = next.events[params.eventId];
      if (previous && previous.fingerprint !== eventFingerprint) fail('EVENT_ID_REUSED');
      let result;
      if (previous) result = previous.result;
      else {
        next.revision = (BigInt(next.revision) + 1n).toString();
        const entity = {
          entityType: 'encounter',
          entityId: params.eventId,
          revision: '1',
          deletedAt: null,
          data: fact,
        };
        result = { entity, workspaceRevision: next.revision };
        next.words[word] ??= { word: copy(params.data.word), collected: false, notebookIds: [] };
        next.words[word].collected = true;
        if (params.notebookId !== null && !next.words[word].notebookIds.includes(params.notebookId))
          next.words[word].notebookIds.push(params.notebookId);
        next.events[params.eventId] = { fingerprint: eventFingerprint, result };
      }
      const operation = {
        mutationId: params.mutationId,
        method: 'recordEncounter',
        status: 'applied',
        result,
      };
      next.receipts[key] = { fingerprint, operation };
      if (abortBeforeCommit) fail('SIMULATED_TRANSACTION_ABORT');
      this.records = next;
      return copy(result);
    } catch (error) {
      if (error.code === 'SIMULATED_TRANSACTION_ABORT') throw error;
      // 业务拒绝形成终态回执；修正意图需要新 mutationId，不覆盖原回执。
      this.records.receipts[key] = {
        fingerprint,
        operation: {
          mutationId: params.mutationId,
          method: 'recordEncounter',
          status: 'rejected',
          error: { code: error.code, message: error.code, retryable: false },
        },
      };
      throw error;
    }
  }
}
module.exports = { CaptureStore };
