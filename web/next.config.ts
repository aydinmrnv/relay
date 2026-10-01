import type { NextConfig } from 'next';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';

/**
 * Extra origins the dev server may be opened from, for testing on a phone or
 * another machine on the network: `RELAY_DEV_ORIGINS=192.168.1.20,my-laptop.local`.
 * Nobody's own address belongs in the repository.
 */
const devOrigins = (process.env.RELAY_DEV_ORIGINS ?? '')
  .split(',')
  .map((origin) => origin.trim())
  .filter(Boolean);

const nextConfig: NextConfig = {
  // This app lives inside the Relay repository, which has its own lockfile.
  turbopack: { root: dirname(fileURLToPath(import.meta.url)) },
  // Let the dev server be opened from another device on the LAN.
  allowedDevOrigins: ['127.0.0.1', 'localhost', '*.local', ...devOrigins],
  // PGlite (the development database) loads its WebAssembly from its own
  // package directory at run time; bundling it would lose those files.
  serverExternalPackages: ['@electric-sql/pglite'],
  // Nothing gains from being told which framework this is.
  poweredByHeader: false,
  async headers() {
    return [
      {
        source: '/:path*',
        headers: [
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
          { key: 'X-Frame-Options', value: 'SAMEORIGIN' },
          { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=()' },
          // The parts of a content security policy that hold without a nonce on every script:
          // no framing by other sites, no <base> rewriting where links go, no plugins.
          { key: 'Content-Security-Policy', value: "frame-ancestors 'self'; base-uri 'self'; object-src 'none'" },
        ],
      },
    ];
  },
};

export default nextConfig;
