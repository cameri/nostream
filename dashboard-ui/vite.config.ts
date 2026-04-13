import { defineConfig, loadEnv } from 'vite'
import react from '@vitejs/plugin-react'

// https://vite.dev/config/
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '');
  const targetPort = env.VITE_DASHBOARD_PORT || 18013;
  const targetHost = env.VITE_DASHBOARD_HOST || '127.0.0.1';

  return {
    plugins: [react()],
    server: {
      proxy: {
        '/api': {
          target: `http://${targetHost}:${targetPort}`,
          changeOrigin: true,
          ws: true,
          configure: (proxy) => {
            proxy.on('error', (err) => {
              if ((err as any).code === 'EPIPE' || (err as any).code === 'ECONNRESET') return;
              console.warn('[vite proxy error]', err);
            });
            proxy.on('proxyReqWs', (proxyReq, req, socket) => {
              socket.on('error', (err) => {
                if ((err as any).code === 'EPIPE' || (err as any).code === 'ECONNRESET') return;
                console.warn('[vite ws proxy socket error]', err);
              });
            });
          },
        },
      },
    },
  };
})
