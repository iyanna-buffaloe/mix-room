import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'
import { fileURLToPath } from 'node:url'
import { localSeparationConfig } from './scripts/localPreview.js'
import { assertPublicAccountEnvironment } from './src/auth/accountConfig.js'

// https://vite.dev/config/
export default defineConfig({
  root: fileURLToPath(new URL('.', import.meta.url)),
  cacheDir: fileURLToPath(new URL('./node_modules/.vite', import.meta.url)),
  resolve: {
    alias: {
      react: fileURLToPath(new URL('./node_modules/react', import.meta.url)),
      'react-dom': fileURLToPath(new URL('./node_modules/react-dom', import.meta.url)),
    },
  },
  publicDir: fileURLToPath(new URL('./public', import.meta.url)),
  // The website and lightweight account-link page are separate entries.
  optimizeDeps: {
    entries: ['index.html', 'auth/confirm/index.html'],
  },
  build: {
    outDir: fileURLToPath(new URL('./dist', import.meta.url)),
    emptyOutDir: true,
    rolldownOptions: {
      input: { main: fileURLToPath(new URL('./index.html', import.meta.url)), email: fileURLToPath(new URL('./auth/confirm/index.html', import.meta.url)) },
    },
  },
  plugins: [react(),
    { name: 'public-account-configuration', configResolved(config) { assertPublicAccountEnvironment(config.env) } },
    { name: 'local-design-preview', configureServer(server) { server.middlewares.use(localSeparationConfig()) } },
    {
      name: 'site-metadata',
      transformIndexHtml(_html, context) {
        if (context.path !== '/index.html') return []
        // Social crawlers need an absolute image URL in the initial HTML.
        // Production builds use the public domain; Netlify's DEPLOY_PRIME_URL
        // there is an internal branch address that link previews should not show.
        const siteUrl = (process.env.CONTEXT === 'production' && process.env.URL) || process.env.DEPLOY_PRIME_URL || process.env.URL || 'https://mixingvisualizer.netlify.app'
        const shareImage = new URL('/branding/mix-room-share.jpg', siteUrl).href
        return [
          { tag: 'meta', attrs: { property: 'og:image', content: shareImage } },
          { tag: 'meta', attrs: { property: 'og:image:type', content: 'image/jpeg' } },
          { tag: 'meta', attrs: { property: 'og:image:width', content: '1200' } },
          { tag: 'meta', attrs: { property: 'og:image:height', content: '1200' } },
          { tag: 'meta', attrs: { property: 'og:image:alt', content: 'A blue ball wearing blue headphones above a grid, with Mix Room underneath.' } },
          { tag: 'meta', attrs: { name: 'twitter:image', content: shareImage } },
          { tag: 'meta', attrs: { name: 'twitter:image:alt', content: 'A blue ball wearing blue headphones above a grid, with Mix Room underneath.' } },
          { tag: 'link', attrs: { rel: 'manifest', href: '/manifest.webmanifest' } },
          { tag: 'link', attrs: { rel: 'apple-touch-icon', sizes: '180x180', href: '/icons/mix-room-180.png' } },
          { tag: 'meta', attrs: { name: 'theme-color', content: '#07111e' } },
          { tag: 'meta', attrs: { name: 'apple-mobile-web-app-capable', content: 'yes' } },
          { tag: 'meta', attrs: { name: 'apple-mobile-web-app-status-bar-style', content: 'black-translucent' } },
          { tag: 'meta', attrs: { name: 'apple-mobile-web-app-title', content: 'Mix Room' } },
        ]
      },
    },
  ],
  server: {
    watch: {
      ignored: [
        '**/projects/annotation-lab/data/**',
        '**/projects/local-audio/analysis/models/**',
        '**/projects/local-audio/analysis/separated/**',
      ],
    },
    proxy: {
      '/api': 'http://127.0.0.1:3001',
    },
  },
})
