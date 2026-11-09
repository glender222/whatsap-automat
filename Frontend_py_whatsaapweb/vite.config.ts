import { defineConfig, type Plugin } from 'vite'
import react from '@vitejs/plugin-react-swc'
import { createReadStream, readdirSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import path from 'path'

function pdfAssets(): Plugin {
  const root = path.dirname(createRequire(import.meta.url).resolve('pdfjs-dist/package.json'))
  const assets = new Map<string, string>()
  for (const directory of ['cmaps', 'iccs', 'standard_fonts', 'wasm']) {
    for (const file of readdirSync(path.join(root, directory), { withFileTypes: true })) {
      if (file.isFile()) assets.set(`pdfjs-assets/${directory}/${file.name}`, path.join(root, directory, file.name))
    }
  }
  return {
    name: 'local-pdf-assets',
    configureServer(server) {
      server.middlewares.use((request, response, next) => {
        const pathname = request.url?.split('?')[0] ?? ''
        if (!pathname.startsWith(server.config.base)) return next()
        const asset = assets.get(pathname.slice(server.config.base.length))
        if (!asset) return next()
        response.setHeader('Content-Type', asset.endsWith('.wasm') ? 'application/wasm' : 'application/octet-stream')
        createReadStream(asset).on('error', next).pipe(response)
      })
    },
    generateBundle() {
      for (const [fileName, source] of assets) {
        this.emitFile({ type: 'asset', fileName, source: readFileSync(source) })
      }
    },
  }
}

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), pdfAssets()],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
})
