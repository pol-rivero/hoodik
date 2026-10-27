import type { PluginOption } from 'vite'

type Options = {
  filename: string
}

export function serviceWorkerPlugin(options: Options): PluginOption {
  const name = 'vite-plugin-service-worker'
  const virtualModuleId = `virtual:${name}`
  const resolvedVirtualModuleId = '\0' + virtualModuleId
  let isBuild = false
  // The worker is emitted at a fixed name, and caches in front of the server
  // (a CDN, the browser) can hold it well past a deploy. A per-build query
  // gives every release its own URL, so a new page never runs an old worker.
  const buildId = Date.now().toString(36)
  return {
    name,
    config(_, { command }) {
      isBuild = command === 'build'
      return {
        build: {
          rollupOptions: {
            input: {
              main: 'index.html',
              sw: options.filename
            },
            output: {
              entryFileNames: ({ facadeModuleId }) => {
                if (facadeModuleId?.includes(options.filename)) {
                  return `[name].js`
                }
                return 'assets/[name].[hash].js'
              }
            }
          }
        }
      }
    },
    resolveId(id) {
      if (id === virtualModuleId) {
        return resolvedVirtualModuleId
      }
    },
    load(id) {
      if (id === resolvedVirtualModuleId) {
        let filename = isBuild ? options.filename.replace('.ts', '.js') : options.filename
        if (!filename.startsWith('/')) filename = `/${filename}`
        if (isBuild) filename = `${filename}?v=${buildId}`
        return `export const serviceWorkerFile = '${filename}'`
      }
    }
  }
}
