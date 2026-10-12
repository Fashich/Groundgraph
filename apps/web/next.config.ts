import path from 'node:path';
import type { NextConfig } from 'next';

const apiOrigin = (process.env.API_ORIGIN || 'http://localhost:8787').replace(/\/$/, '');

const securityHeaders = [
  { key: 'X-Content-Type-Options', value: 'nosniff' },
  { key: 'X-Frame-Options', value: 'DENY' },
  { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
  { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=()' },
];

const nextConfig: NextConfig = {
  output: 'standalone',
  // e2e builds go to their own folder so they never clobber a dev or production build
  distDir: process.env.NEXT_DIST_DIR || '.next',
  // The monorepo root, so the standalone output traces workspace packages (@groundgraph/ui, @groundgraph/sdk).
  outputFileTracingRoot: path.join(__dirname, '../../'),
  turbopack: { root: path.join(__dirname, '../../') },
  outputFileTracingIncludes: { '/**/*': ['./content/legal/**/*'] },
  transpilePackages: ['@groundgraph/ui', '@groundgraph/sdk'],
  poweredByHeader: false,
  reactStrictMode: true,
  async rewrites() {
    return [
      { source: '/api/:path*', destination: `${apiOrigin}/:path*` },
      // Live updates in production go through the same origin; the WebSocket upgrade is handled by the reverse proxy in front of this app.
      { source: '/og/:path*', destination: `${apiOrigin}/og/:path*` },
    ];
  },
  async headers() {
    return [
      { source: '/:path*', headers: securityHeaders },
      // Solana Actions discovery file must be readable cross-origin by Blink clients.
      {
        source: '/actions.json',
        headers: [
          { key: 'Access-Control-Allow-Origin', value: '*' },
          { key: 'Access-Control-Allow-Methods', value: 'GET,OPTIONS' },
          { key: 'Access-Control-Allow-Headers', value: 'Content-Type,Authorization,Content-Encoding,Accept-Encoding' },
        ],
      },
    ];
  },
};

export default nextConfig;
