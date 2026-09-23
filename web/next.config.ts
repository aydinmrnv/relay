import type { NextConfig } from 'next';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';

const nextConfig: NextConfig = {
  // This app lives inside the Relay repository, which has its own lockfile.
  turbopack: { root: dirname(fileURLToPath(import.meta.url)) },
  // Let the dev server be opened from another device or IP on the LAN.
  allowedDevOrigins: ['192.168.0.37', '127.0.0.1', 'localhost', '*.local'],
};

export default nextConfig;
