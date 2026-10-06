'use strict';

// 浏览器可选扩展的授权与回执参考模型，不参与基础读写接口协商。
const { hash } = require('./reference.cjs');
const copy = (value) => structuredClone(value);
const fail = (code) => {
  throw Object.assign(new Error(code), { code });
};
const same = (a, b) => typeof a === 'string' && a === b;
const instant = (value) => new Date(value).toISOString();
const capabilities = {
  'browser.getContext': 'browser.context/1',
  'browser.readSelection': 'browser.selection/1',
  'browser.highlight': 'browser.highlight/1',
  'browser.openSource': 'browser.open-source/1',
  'browser.requestSidePanel': 'browser.side-panel/1',
};
// 传输上下文与调用截止时间先于具体动作和历史回执处理。
function hostGuard(request, grant, now) {
  if (
    request.connectionId !== grant.connectionId ||
    request.grantId !== grant.id ||
    request.grantToken !== grant.token ||
    hash(request.workspace) !== hash(grant.workspace) ||
    grant.revoked
  )
    fail('STALE_GRANT');
  if (Date.parse(grant.expiresAt) <= Date.parse(now)) fail('STALE_GRANT');
  const remaining = Date.parse(request.deadlineAt) - Date.parse(now);
  if (remaining <= 0 || remaining > 30000) fail('DEADLINE_EXCEEDED');
  const capability = capabilities[request.method];
  if (capability && !grant.capabilities.includes(capability)) fail('CAPABILITY_UNAVAILABLE');
  if (
    request.params.pageHandle &&
    grant.authorizedPages?.[request.params.pageHandle] !== request.params.documentRevision
  )
    fail('PAGE_STALE');
}
class HostReceiptJournal {
  constructor(snapshot = null) {
    this.grants = snapshot ? copy(snapshot.grants) : {};
    this.receipts = snapshot ? copy(snapshot.receipts) : {};
    this.revokedOwners = snapshot ? copy(snapshot.revokedOwners) : {};
  }
  snapshot() {
    return copy({
      grants: this.grants,
      receipts: this.receipts,
      revokedOwners: this.revokedOwners,
    });
  }
  register(grant) {
    if (this.revokedOwners[hash(grant.owner)]) fail('PAIRING_REVOKED');
    for (const old of Object.values(this.grants))
      if (hash(old.owner) === hash(grant.owner)) old.invalid = true;
    this.grants[grant.id] = { ...copy(grant), tokenHash: hash(grant.token) };
    delete this.grants[grant.id].token;
  }
  current(id, token, now) {
    const grant = this.grants[id];
    if (
      !grant ||
      !same(grant.tokenHash, hash(token)) ||
      grant.invalid ||
      Date.parse(grant.expiresAt) <= Date.parse(now)
    )
      fail('STALE_GRANT');
    if (this.revokedOwners[hash(grant.owner)]) fail('PAIRING_REVOKED');
    return grant;
  }
  execute(id, token, invocationId, method, params, now, action) {
    const grant = this.current(id, token, now),
      fingerprint = hash({ method, params });
    if (!capabilities[method] || !grant.capabilities.includes(capabilities[method]))
      fail('CAPABILITY_UNAVAILABLE');
    if (params.pageHandle && grant.authorizedPages?.[params.pageHandle] !== params.documentRevision)
      fail('PAGE_STALE');
    const key = hash({ owner: grant.owner, invocationId });
    const previous = this.receipts[key];
    if (previous) {
      if (previous.sourceGrantId !== id) fail('OPERATION_RECOVERY_REQUIRED');
      if (previous.fingerprint !== fingerprint) fail('IDEMPOTENCY_KEY_REUSED');
      return copy(previous.receipt);
    }
    const receipt = { method, ok: true, result: copy(action()) };
    this.receipts[key] = {
      sourceGrantId: id,
      invocationId,
      owner: copy(grant.owner),
      params: copy(params),
      fingerprint,
      status: 'applied',
      receipt,
      resultDigest: hash(receipt),
      retainedUntil: instant(Date.parse(now) + 7 * 24 * 60 * 60 * 1000),
    };
    return copy(receipt);
  }
  recover(id, token, sourceGrantId, invocationId, now) {
    const current = this.current(id, token, now),
      source = this.grants[sourceGrantId];
    if (
      !source ||
      hash(source.owner) !== hash(current.owner) ||
      this.revokedOwners[hash(source.owner)]
    )
      fail('FORBIDDEN');
    const saved = this.receipts[hash({ owner: current.owner, invocationId })];
    if (
      !saved ||
      saved.sourceGrantId !== sourceGrantId ||
      Date.parse(saved.retainedUntil) <= Date.parse(now)
    )
      return {
        sourceGrantId,
        invocationId,
        status: 'unknown',
        resultDigest: null,
        receipt: null,
        contentStatus: saved ? 'not-retained' : 'not-applicable',
      };
    const capability = {
      'browser.getContext': 'browser.context/1',
      'browser.readSelection': 'browser.selection/1',
      'browser.highlight': 'browser.highlight/1',
      'browser.openSource': 'browser.open-source/1',
      'browser.requestSidePanel': 'browser.side-panel/1',
    }[saved.receipt.method];
    const page = saved.params.pageHandle;
    const contentAllowed =
      current.capabilities.includes(capability) &&
      (!page || current.authorizedPages?.[page] === saved.params.documentRevision) &&
      (saved.receipt.method !== 'browser.getContext' ||
        !saved.receipt.result.page ||
        current.authorizedPages?.[saved.receipt.result.page.pageHandle] ===
          saved.receipt.result.page.documentRevision);
    return {
      sourceGrantId,
      invocationId,
      status: saved.status,
      resultDigest: saved.resultDigest,
      receipt: contentAllowed ? copy(saved.receipt) : null,
      contentStatus: contentAllowed ? 'available' : 'not-authorized',
    };
  }
  invalidate(id) {
    this.grants[id].invalid = true;
  }
  revokeOwner(owner) {
    this.revokedOwners[hash(owner)] = true;
  }
}
module.exports = { HostReceiptJournal, hostGuard };
