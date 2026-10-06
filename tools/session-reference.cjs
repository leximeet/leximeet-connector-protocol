'use strict';

// 小型状态参考模型，用于验证跨重启、断线与工作区边界；不是安全存储或生产传输实现。
const { randomUUID, randomBytes, timingSafeEqual } = require('node:crypto');
const { hash } = require('./reference.cjs');
const copy = (value) => structuredClone(value);
const fail = (code) => {
  throw Object.assign(new Error(code), { code });
};
const instant = (value) => new Date(value).toISOString();
const equal = (a, b) => {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const x = Buffer.from(a),
    y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
};
const identityFields = ['desktopInstanceId', 'workspaceId', 'generation', 'authorizationEpoch'];

class PairingRegistry {
  constructor(snapshot = null) {
    this.records = snapshot ? copy(snapshot.records) : {};
    this.sessions = snapshot ? copy(snapshot.sessions) : {};
  }
  snapshot() {
    return copy({ records: this.records, sessions: this.sessions });
  }
  pair(origin, identity, scopes, connectionId, now) {
    const pairingId = randomUUID(),
      pairingToken = randomBytes(32).toString('base64url');
    const owner = { ...copy(identity), pairingId };
    this.records[pairingId] = {
      owner,
      origin,
      scopes: copy(scopes),
      tokenHash: hash(pairingToken),
      revoked: false,
    };
    return {
      ...this.issue(pairingId, connectionId, now),
      pairingCredential: { ...owner, pairingToken },
    };
  }
  checkIdentity(record, current) {
    for (const field of identityFields)
      if (record.owner[field] !== current[field]) fail('GENERATION_MISMATCH');
  }
  resume(origin, credential, currentIdentity, connectionId, now) {
    const record = this.records[credential.pairingId];
    if (
      !record ||
      record.revoked ||
      record.origin !== origin ||
      !equal(record.tokenHash, hash(credential.pairingToken))
    )
      fail('PAIRING_REVOKED');
    if (record.disconnected) fail('CONNECTION_ENDED');
    for (const field of [...identityFields, 'pairingId', 'clientInstanceId'])
      if (credential[field] !== record.owner[field]) fail('FORBIDDEN');
    this.checkIdentity(record, currentIdentity);
    return this.issue(credential.pairingId, connectionId, now);
  }
  issue(pairingId, connectionId, now) {
    const record = this.records[pairingId];
    if (!record || record.revoked) fail('PAIRING_REVOKED');
    const sessionId = randomUUID(),
      sessionToken = randomBytes(32).toString('base64url');
    const expiresAt = instant(Date.parse(now) + 24 * 60 * 60 * 1000);
    const authorization = {
      sessionId,
      sessionToken,
      workspaceId: record.owner.workspaceId,
      generation: record.owner.generation,
      authorizationEpoch: record.owner.authorizationEpoch,
    };
    this.sessions[sessionId] = {
      pairingId,
      connectionId,
      tokenHash: hash(sessionToken),
      expiresAt,
      closed: false,
    };
    return {
      authorization,
      expiresAt,
      readLeaseUntil: instant(Date.parse(now) + 30000),
      scopes: copy(record.scopes),
      pairingId,
      owner: copy(record.owner),
    };
  }
  authorize(origin, authorization, connectionId, currentIdentity, now) {
    const session = this.sessions[authorization.sessionId],
      record = session && this.records[session.pairingId];
    if (
      !record ||
      record.revoked ||
      session.closed ||
      record.origin !== origin ||
      !equal(session.tokenHash, hash(authorization.sessionToken))
    )
      fail('UNAUTHORIZED');
    if (session.connectionId !== connectionId) fail('STALE_CONNECTION');
    if (Date.parse(session.expiresAt) <= Date.parse(now)) fail('SESSION_EXPIRED');
    this.checkIdentity(record, currentIdentity);
    for (const field of ['workspaceId', 'generation', 'authorizationEpoch'])
      if (authorization[field] !== record.owner[field]) fail('FORBIDDEN');
    return record;
  }
  renew(origin, authorization, connectionId, currentIdentity, now) {
    const record = this.authorize(origin, authorization, connectionId, currentIdentity, now);
    return this.issue(record.owner.pairingId, connectionId, now);
  }
  readLease(origin, authorization, connectionId, currentIdentity, now) {
    this.authorize(origin, authorization, connectionId, currentIdentity, now);
    return instant(
      Math.min(
        Date.parse(now) + 30000,
        Date.parse(this.sessions[authorization.sessionId].expiresAt),
      ),
    );
  }
  disconnect(origin, authorization, connectionId, currentIdentity, now) {
    const record = this.authorize(origin, authorization, connectionId, currentIdentity, now);
    for (const session of Object.values(this.sessions)) {
      if (session.pairingId === record.owner.pairingId) session.closed = true;
    }
    record.disconnected = true;
    return { disconnected: true, pairingRetained: true };
  }
  revoke(origin, authorization, connectionId, currentIdentity, pairingId, now) {
    const record = this.authorize(origin, authorization, connectionId, currentIdentity, now);
    if (record.owner.pairingId !== pairingId) fail('FORBIDDEN');
    record.revoked = true;
    return { pairingId, revoked: true };
  }
}

function version(value) {
  if (!/^[0-9]+\.[0-9]+\.[0-9]+$/.test(value)) fail('UNSUPPORTED_VERSION');
  return value.split('.').map(BigInt);
}
function negotiate(local, peer) {
  const needed = version(local.minApiVersion),
    actual = version(peer.apiVersion);
  if (
    needed[0] !== actual[0] ||
    actual[1] < needed[1] ||
    (actual[1] === needed[1] && actual[2] < needed[2])
  )
    fail('UNSUPPORTED_VERSION');
  if (!local.requiredCapabilities.every((cap) => peer.capabilities.includes(cap)))
    fail('CAPABILITY_UNAVAILABLE');
  // 预发布不兼容旧候选；正式 1.x 按版本与必需能力判断兼容性，不以全仓摘要相同为前提。
  if (local.contractVersion.includes('-') || peer.contractVersion.includes('-')) {
    if (
      local.contractVersion !== peer.contractVersion ||
      local.contractDigest !== peer.contractDigest
    )
      fail('CONTRACT_MISMATCH');
  }
  return true;
}

class WorkspaceRouter {
  constructor(localData, binding = null, snapshot = null) {
    Object.assign(
      this,
      snapshot
        ? copy(snapshot)
        : {
            mode: 'independent',
            epoch: 1,
            localData: copy(localData),
            localBinding: binding,
            owner: null,
            frozen: false,
            account: null,
            syncEnabled: false,
            pending: {},
            recovery: [],
            displayed: [],
          },
    );
  }
  snapshot() {
    return copy({ ...this });
  }
  begin() {
    if (this.mode !== 'independent') fail('INVALID_MODE');
    this.mode = 'preparing';
    this.epoch++;
    this.frozen = true;
    // 元数据保留归属；独立账号退出，不把任何令牌放入归档。
    this.account = null;
    this.syncEnabled = false;
  }
  bind(owner) {
    if (!['preparing', 'reconnecting'].includes(this.mode)) fail('INVALID_MODE');
    if (this.mode === 'reconnecting' && hash(owner) !== hash(this.owner)) fail('OWNER_CHANGED');
    this.owner = copy(owner);
    this.mode = 'connected';
    this.epoch++;
  }
  saveLocal(value) {
    if (this.mode !== 'independent' || this.frozen) fail('OWNER_NOT_WRITABLE');
    this.localData.push(copy(value));
  }
  send(id, payload) {
    if (this.mode !== 'connected') fail('OWNER_NOT_WRITABLE');
    const context = { id, owner: copy(this.owner), epoch: this.epoch, payload: copy(payload) };
    this.pending[hash({ owner: this.owner, id })] = context;
    return copy(context);
  }
  receive(context, result) {
    const key = hash({ owner: context.owner, id: context.id });
    if (!this.pending[key] || hash(this.pending[key]) !== hash(context)) return false;
    delete this.pending[key];
    if (
      this.mode !== 'connected' ||
      context.epoch !== this.epoch ||
      hash(context.owner) !== hash(this.owner)
    ) {
      this.recovery.push({ context: copy(context), result: copy(result) });
      return false;
    }
    this.displayed.push(copy(result));
    return true;
  }
  lostConnection() {
    if (this.mode === 'connected') {
      this.mode = 'reconnecting';
      this.epoch++;
      this.displayed = [];
    }
  }
  restoreIndependent() {
    if (!['preparing', 'connected', 'reconnecting'].includes(this.mode)) fail('INVALID_MODE');
    this.mode = 'independent';
    this.epoch++;
    this.frozen = false;
    this.account = null;
    this.syncEnabled = false;
    this.displayed = [];
    // 原 owner 的未知操作保留在 pending，禁止向本地库自动重放。
  }
}
module.exports = { PairingRegistry, negotiate, WorkspaceRouter };
