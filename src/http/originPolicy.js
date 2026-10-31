'use strict';

/**
 * 本地接口来源校验。
 *
 * 服务可读取配置并导出私钥，必须阻止公网页面通过 DNS rebinding
 * 以同源身份访问回环接口；校验不依赖 Cookie，也不引入额外令牌。
 */
function createOriginPolicy({ port, host = '127.0.0.1' }) {
  const allowedHosts = new Set([`${host}:${port}`, `localhost:${port}`]);
  const allowedOrigins = new Set([`http://${host}:${port}`, `http://localhost:${port}`]);

  return function assertAllowed(headers) {
    const hostHeader = String(headers.host || '').trim().toLowerCase();
    if (!allowedHosts.has(hostHeader)) {
      return 'host';
    }

    const origin = String(headers.origin || '').trim().toLowerCase();
    if (origin && !allowedOrigins.has(origin)) {
      return 'origin';
    }

    const site = String(headers['sec-fetch-site'] || '').trim().toLowerCase();
    if (site && site !== 'same-origin' && site !== 'none') {
      return 'site';
    }
    return null;
  };
}

module.exports = { createOriginPolicy };
