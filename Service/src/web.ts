import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { extname, join, resolve, sep } from 'node:path';

const CONTENT_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
};

// Maps a request URL to a file inside webRoot; undefined when it escapes the root or names no file.
export function resolveWebFile(webRoot: string, requestUrl: string): string | undefined {
  const root = resolve(webRoot);
  const pathPart = requestUrl.split(/[?#]/, 1)[0] ?? '/';
  let relative: string;
  try {
    relative = decodeURIComponent(pathPart);
  } catch {
    return undefined;
  }
  const target = resolve(root, `.${relative.startsWith('/') ? '' : '/'}${relative}`);
  if (target !== root && !target.startsWith(root + sep)) return undefined;
  const file = target === root ? join(root, 'index.html') : target;
  return existsSync(file) && statSync(file).isFile() ? file : undefined;
}

// Serves the web app (Resources/LocHubWeb) and, for files it does not have, the vendor chunk folder
// (Source/ThirdParty/LocHubWebDeps). API routes are static and win over the wildcard.
export function registerWebApp(app: FastifyInstance, webRoot: string, depsRoot?: string): void {
  const handler = async (request: FastifyRequest, reply: FastifyReply) => {
    if (request.url.startsWith('/api/')) return reply.code(404).send({ error: 'Unknown API route' });
    const file = resolveWebFile(webRoot, request.url) ?? (depsRoot ? resolveWebFile(depsRoot, request.url) : undefined);
    if (!file) {
      if (!existsSync(join(webRoot, 'index.html')))
        return reply
          .code(503)
          .type('text/plain; charset=utf-8')
          .send(
            'The LocHub web app is missing: Resources/LocHubWeb/index.html was not found in the plugin. Reinstall the plugin; in the source repository run "npm run build" in Web/.',
          );
      return reply.code(404).type('text/plain; charset=utf-8').send('Not found');
    }
    const type = CONTENT_TYPES[extname(file).toLowerCase()] ?? 'application/octet-stream';
    // Names are fixed (no content hashes, spec §3), so every file must be revalidated: a plugin update would
    // otherwise leave the editor tab on a cached script.
    return reply.code(200).type(type).header('cache-control', 'no-cache').send(readFileSync(file));
  };
  app.get('/', handler);
  app.get('/*', handler);
}
