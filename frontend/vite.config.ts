import { defineConfig, type Plugin } from 'vitest/config';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { ensureDevHttpsCertificate } from './devHttpsCert';

function androidDevDiagnosticsPlugin(): Plugin {
  return {
    name: 'packingproof-android-dev-diag',
    configureServer(server) {
      server.middlewares.use('/__android_diag', (req, res, next) => {
        if (req.method !== 'POST') {
          next();
          return;
        }
        let body = '';
        req.on('data', (chunk: Buffer | string) => {
          if (body.length < 32_768) {
            body += chunk.toString();
          }
        });
        req.on('end', () => {
          console.info(`[ANDROID-DIAG ${new Date().toISOString()}] ${body}`);
          res.statusCode = 204;
          res.end();
        });
      });
    }
  };
}

export default defineConfig(({ command, mode }) => {
  const isDevServe = command === 'serve' && mode !== 'test';
  const enableHttps =
    isDevServe && process.env.VITE_DEV_HTTPS !== 'false';
  const httpsCert = enableHttps ? ensureDevHttpsCertificate() : undefined;

  return {
    plugins: isDevServe
      ? [tailwindcss(), react(), androidDevDiagnosticsPlugin()]
      : [tailwindcss(), react()],
    optimizeDeps: {
      include: [
        'react',
        'react-dom',
        'react-dom/client',
        'react-router-dom',
        'lucide-react',
        '@zxing/browser',
        '@zxing/library',
        'tus-js-client'
      ]
    },
    server: {
      host: true,
      port: 5173,
      strictPort: true,
      https: httpsCert
        ? {
            key: httpsCert.key,
            cert: httpsCert.cert
          }
        : undefined,
      proxy: {
        '/api': {
          target: 'http://localhost:5080',
          changeOrigin: false,
          xfwd: true
        },
        '/health': {
          target: 'http://localhost:5080',
          changeOrigin: false,
          xfwd: true
        }
      }
    },
    build: {
      chunkSizeWarningLimit: 600,
      rollupOptions: {
        output: {
          manualChunks(id) {
            if (id.includes('node_modules/@zxing/')) {
              return 'vendor-zxing';
            }
            if (id.includes('node_modules/lucide-react/')) {
              return 'vendor-icons';
            }
            if (
              id.includes('node_modules/react/') ||
              id.includes('node_modules/react-dom/') ||
              id.includes('node_modules/react-router')
            ) {
              return 'vendor-react';
            }
            return undefined;
          }
        }
      }
    },
    test: {
      globals: true,
      environment: 'jsdom',
      setupFiles: ['./tests/setupTests.ts'],
      css: true
    }
  };
});
