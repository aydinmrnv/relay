import type { NextConfig } from 'next';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';

const nextConfig: NextConfig = {
  // This app lives inside the Relay repository, which has its own lockfile.
  turbopack: { root: dirname(fileURLToPath(import.meta.url)) },
  // Let the dev server be opened from another device or IP on the LAN.
  allowedDevOrigins: ['192.168.0.37', '127.0.0.1', 'localhost', '*.local'],
  // PGlite (the development database) loads its WebAssembly from its own
  // package directory at run time; bundling it would lose those files.
  serverExternalPackages: ['@electric-sql/pglite'],
  async headers() {
    return [
      {
        source: '/:path*',
        headers: [
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
          { key: 'X-Frame-Options', value: 'SAMEORIGIN' },
          { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=()' },
        ],
      },
    ];
  },
};

export default nextConfig;
