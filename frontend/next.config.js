// Next loads ONLY this file (next.config.js wins over next.config.mjs), so all
// rewrites live here. Two proxies, both same-origin so the browser never hits
// cross-origin CORS:
//   1. /api/*  -> the Express backend, enabled only when BACKEND_PROXY_TARGET is set
//      (the dormant deploy mode previously sketched in next.config.mjs).
//   2. /data-review-app/*  -> the Python review server (serve.py). Keeps the
//      Python port private to the host; the browser only ever talks to this origin.
const backendProxyTarget = process.env.BACKEND_PROXY_TARGET;
const dataReviewTarget = process.env.DATA_REVIEW_TARGET || 'http://127.0.0.1:8765';

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // The review app (mounted at /data-review-app/) uses RELATIVE fetches
  // (data.json, comment, ...), which only resolve while the document keeps its
  // trailing slash, so stop Next auto-stripping it. (Global flag, but it only
  // disables the automatic trailing-slash *redirect* — existing routes still
  // resolve unchanged.) Always link to the app WITH the trailing slash; the
  // CP3 iframe src does this. A bare /data-review-app won't redirect, by design
  // (an explicit redirect here self-loops under skipTrailingSlashRedirect).
  skipTrailingSlashRedirect: true,
  async rewrites() {
    const rules = [];
    if (backendProxyTarget) {
      rules.push({ source: '/api/:path*', destination: `${backendProxyTarget}/api/:path*` });
    }
    rules.push({ source: '/data-review-app/:path*', destination: `${dataReviewTarget}/:path*` });
    return rules;
  },
};

module.exports = nextConfig;
