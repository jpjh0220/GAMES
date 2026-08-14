import { defineConfig } from 'vite';
import { VitePWA } from 'vite-plugin-pwa';
import compression from 'vite-plugin-compression';

export default defineConfig({
  plugins: [
    VitePWA({
      registerType: 'autoUpdate',
      includeAssets: ['icon.svg', 'favicon.ico'],
      manifest: {
        name: 'GAMES: Earthbound + Sol',
        short_name: 'GAMES',
        description: 'Autonomous AI agent in RuneScape + 3D Earth exploration',
        theme_color: '#06111f',
        background_color: '#02060c',
        display: 'standalone',
        orientation: 'landscape-primary',
        start_url: '/',
        scope: '/',
        icons: [
          {
            src: 'icon.svg',
            sizes: '192x192 512x512',
            type: 'image/svg+xml',
            purpose: 'any maskable'
          }
        ],
        screenshots: [
          {
            src: 'screenshot-1.png',
            type: 'image/png',
            sizes: '1280x720',
            form_factor: 'wide'
          }
        ],
        categories: ['games', 'productivity'],
        shortcuts: [
          {
            name: 'Play Earthbound',
            short_name: 'Earthbound',
            description: 'Launch Earth exploration game',
            url: '/?game=earthbound',
            icons: [{ src: 'icon-earthbound.svg', sizes: '96x96' }]
          },
          {
            name: 'Watch Sol',
            short_name: 'Sol Agent',
            description: 'Watch AI agent play RuneScape',
            url: '/?game=sol',
            icons: [{ src: 'icon-sol.svg', sizes: '96x96' }]
          }
        ]
      },
      workbox: {
        globPatterns: ['**/*.{js,css,html,svg,png,ico,woff2}'],
        runtimeCaching: [
          {
            urlPattern: /^https:\/\/cdn\.jsdelivr\.net\/.*/i,
            handler: 'CacheFirst',
            options: {
              cacheName: 'jsdelivr-cache',
              expiration: { maxEntries: 20, maxAgeSeconds: 60 * 60 * 24 * 30 }
            }
          }
        ],
        skipWaiting: true,
        clientsClaim: true
      }
    }),
    compression({
      filter: /\.(js|css|json|svg)$/i,
      algorithm: 'brotli',
      ext: '.br',
      disable: false
    })
  ],
  build: {
    target: 'es2020',
    minify: 'terser',
    sourcemap: false,
    reportCompressedSize: true,
    rollupOptions: {
      output: {
        manualChunks: {
          'three-core': ['three'],
          'game': ['./src/game/index.ts'],
          'agent': ['./src/agent/index.ts']
        }
      }
    },
    terserOptions: {
      compress: {
        drop_console: true,
        passes: 3
      },
      format: {
        comments: false
      }
    }
  },
  server: {
    middlewareMode: true,
    hmr: {
      protocol: 'ws',
      host: 'localhost',
      port: 5173
    }
  },
  resolve: {
    alias: {
      '@': '/src',
      '@game': '/src/game',
      '@agent': '/src/agent',
      '@shared': '/src/shared'
    }
  },
  define: {
    __DEV__: JSON.stringify(process.env.NODE_ENV === 'development'),
    __BUILD_TIME__: JSON.stringify(new Date().toISOString()),
    __VERSION__: JSON.stringify(process.env.npm_package_version || '2.0.0')
  }
});
