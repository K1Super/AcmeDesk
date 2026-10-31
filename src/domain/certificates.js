'use strict';

/**
 * 证书快照解析与状态判定。
 *
 * 远端输出为制表符分隔的原始字段，本模块只负责把它转换为可展示结构，
 * 不做任何远端访问，便于独立测试。
 */

const STAGING_MARKERS = ['staging', 'acme-staging'];
const EXPIRING_DAYS = 30;
// acme.sh 在没有 SAN 时把 Le_Alt 写成 no，不能当作备用域名展示
const ALT_SENTINELS = new Set(['no', 'none']);

function toIso(value) {
  const epoch = Number(value);
  if (!Number.isFinite(epoch) || epoch <= 0) {
    return null;
  }
  return new Date(epoch * 1000).toISOString();
}

function daysLeft(isoTime, now = Date.now()) {
  if (!isoTime) {
    return null;
  }
  const expires = Date.parse(isoTime);
  if (Number.isNaN(expires)) {
    return null;
  }
  return Math.floor((expires - now) / 86400000);
}

function isStagingServer(caServer) {
  const value = String(caServer || '').toLowerCase();
  return STAGING_MARKERS.some((marker) => value.includes(marker));
}

function parseAltNames(raw, mainDomain) {
  const names = String(raw || '')
    .split(',')
    .map((item) => item.trim().toLowerCase())
    .filter((item) => item && !ALT_SENTINELS.has(item));
  const unique = [];
  for (const name of names) {
    if (name !== mainDomain && !unique.includes(name)) {
      unique.push(name);
    }
  }
  return unique;
}

function certificateStatus({ days, staging }) {
  if (days === null) {
    return 'unknown';
  }
  if (days < 0) {
    return 'expired';
  }
  if (days < EXPIRING_DAYS) {
    return 'expiring';
  }
  return staging ? 'staging' : 'active';
}

function parseCertificates(raw, now = Date.now()) {
  const lines = String(raw || '')
    .split('\n')
    .map((line) => line.trimEnd())
    .filter(Boolean);

  const items = [];
  for (const line of lines) {
    const fields = line.split('\t');
    if (fields.length < 9) {
      continue;
    }
    const [domain, altRaw, keyLength, webroot, caServer, nextRenewEpoch, startEpoch, endEpoch, dirName] = fields;
    if (!domain) {
      continue;
    }
    const staging = isStagingServer(caServer);
    const notBefore = toIso(startEpoch);
    const notAfter = toIso(endEpoch);
    const remaining = daysLeft(notAfter, now);

    items.push({
      domain,
      altNames: parseAltNames(altRaw, domain),
      keyLength,
      keyAlgorithm: keyLength.startsWith('ec-') ? 'ECDSA' : 'RSA',
      webroot,
      caServer,
      staging,
      notBefore,
      notAfter,
      daysLeft: remaining,
      nextRenewAt: toIso(nextRenewEpoch),
      dirName,
      status: certificateStatus({ days: remaining, staging })
    });
  }

  items.sort((a, b) => {
    if (a.staging !== b.staging) {
      return a.staging ? 1 : -1;
    }
    const left = a.notAfter ? Date.parse(a.notAfter) : Number.POSITIVE_INFINITY;
    const right = b.notAfter ? Date.parse(b.notAfter) : Number.POSITIVE_INFINITY;
    if (left !== right) {
      return left - right;
    }
    return a.domain.localeCompare(b.domain);
  });

  return items;
}

function summarize(items, now = Date.now()) {
  const production = items.filter((item) => !item.staging);
  const expiring = production.filter((item) => item.status === 'expired' || item.status === 'expiring');
  const active = production.filter((item) => item.status === 'active');
  const nearest = production
    .filter((item) => item.notAfter)
    .sort((a, b) => Date.parse(a.notAfter) - Date.parse(b.notAfter))[0] || null;

  return {
    total: items.length,
    production: production.length,
    staging: items.length - production.length,
    active: active.length,
    expiring: expiring.length,
    nearest: nearest
      ? {
          domain: nearest.domain,
          notAfter: nearest.notAfter,
          daysLeft: daysLeft(nearest.notAfter, now)
        }
      : null
  };
}

module.exports = {
  toIso,
  daysLeft,
  parseCertificates,
  summarize,
  isStagingServer
};
