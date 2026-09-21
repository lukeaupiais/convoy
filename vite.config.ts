import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
const lan = process.env.CONVOY_DEV_LAN;
if (lan && !/^192\.168\.\d{1,3}\.\d{1,3}$/.test(lan))
  throw new Error('Set CONVOY_DEV_LAN to your private Wi-Fi IPv4 address.');
const port = lan ? 5174 : 5173;
export default defineConfig({
  root: 'apps/web',
  publicDir: 'public',
  plugins: [
    react(),
    ...(lan
      ? [
          {
            name: 'temporary-lan-dev',
            configureServer(server: any) {
              server.middlewares.use((req: any, res: any, next: any) => {
                const address = (req.socket.remoteAddress ?? '').replace(/^::ffff:/, '');
                const host = req.headers.host;
                const origin = req.headers.origin;
                const lanOrigin = `http://${lan}:${port}`;
                const loopbackOrigins = new Set([
                  `http://localhost:${port}`,
                  `http://127.0.0.1:${port}`,
                ]);
                const fromLoopback = address === '127.0.0.1' || address === '::1';
                const validLoopback =
                  fromLoopback &&
                  (host === `localhost:${port}` || host === `127.0.0.1:${port}`) &&
                  (!origin || loopbackOrigins.has(origin));
                const validLan =
                  address.startsWith(lan.slice(0, lan.lastIndexOf('.') + 1)) &&
                  host === `${lan}:${port}` &&
                  (!origin || origin === lanOrigin);
                if (!validLoopback && !validLan) {
                  res.statusCode = 403;
                  res.end('Local development network only.');
                  return;
                }
                next();
              });
            },
          },
        ]
      : []),
  ],
  server: {
    host: lan ? '0.0.0.0' : '127.0.0.1',
    port,
    strictPort: true,
    fs: { deny: ['**/.env*', '**/.git/**', '**/.convoy/**', '**/*.{crt,pem}'] },
    proxy: {
      '/api': {
        target: 'http://127.0.0.1:4317',
        changeOrigin: true,
        configure(proxy) {
          proxy.on('proxyReq', (request) => {
            request.setHeader('origin', 'http://127.0.0.1:4317');
          });
        },
      },
    },
  },
  build: { outDir: '../../dist', emptyOutDir: true },
});
