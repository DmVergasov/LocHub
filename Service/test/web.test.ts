import Fastify from 'fastify';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { registerWebApp, resolveWebFile } from '../src/web.js';

function makeDist(): string {
  const root = mkdtempSync(join(tmpdir(), 'lochub-web-'));
  mkdirSync(join(root, 'dist', 'assets'), { recursive: true });
  writeFileSync(join(root, 'dist', 'index.html'), '<!doctype html><div id="root"></div>');
  writeFileSync(join(root, 'dist', 'assets', 'index-abc.js'), 'console.log(1)');
  writeFileSync(join(root, 'dist', 'lochub_web.js'), 'console.log(2)');
  writeFileSync(join(root, 'secret.txt'), 'outside the web root');
  return join(root, 'dist');
}

describe('web app serving', () => {
  it('serves index.html at the root without caching and assets with their type', async () => {
    const app = Fastify();
    registerWebApp(app, makeDist());
    const index = await app.inject({ method: 'GET', url: '/?host=editor' });
    expect(index.statusCode).toBe(200);
    expect(index.headers['content-type']).toContain('text/html');
    expect(index.headers['cache-control']).toBe('no-cache');
    expect(index.body).toContain('<div id="root">');
    const script = await app.inject({ method: 'GET', url: '/assets/index-abc.js' });
    expect(script.statusCode).toBe(200);
    expect(script.headers['content-type']).toContain('text/javascript');
  });

  it('never serves a file outside the web root', async () => {
    const dist = makeDist();
    expect(resolveWebFile(dist, '/../secret.txt')).toBeUndefined();
    expect(resolveWebFile(dist, '/..%2Fsecret.txt')).toBeUndefined();
    expect(resolveWebFile(dist, '/%2e%2e/secret.txt')).toBeUndefined();
    expect(resolveWebFile(dist, '/%E0%A4%A')).toBeUndefined();
    expect(resolveWebFile(dist, '/assets')).toBeUndefined();
    const app = Fastify();
    registerWebApp(app, dist);
    expect((await app.inject({ method: 'GET', url: '/..%2Fsecret.txt' })).statusCode).toBe(404);
  });

  it('answers unknown API paths with JSON 404 and explains a missing build', async () => {
    const app = Fastify();
    registerWebApp(app, join(tmpdir(), 'lochub-web-not-built'));
    const api = await app.inject({ method: 'GET', url: '/api/nope' });
    expect(api.statusCode).toBe(404);
    expect(api.json().error).toBe('Unknown API route');
    const page = await app.inject({ method: 'GET', url: '/' });
    expect(page.statusCode).toBe(503);
    expect(page.body).toContain('npm run build');
  });

  it('serves every file with no-cache: names are fixed, so a plugin update must not leave the tab on an old script', async () => {
    const app = Fastify();
    registerWebApp(app, makeDist());
    const script = await app.inject({ method: 'GET', url: '/lochub_web.js' });
    expect(script.statusCode).toBe(200);
    expect(script.headers['cache-control']).toBe('no-cache');
  });

  it('serves the vendor chunk from the deps folder under the same URL', async () => {
    const dist = makeDist();
    const deps = mkdtempSync(join(tmpdir(), 'lochub-web-deps-'));
    writeFileSync(join(deps, 'lochub_web_deps.js'), 'export const vendor = 1;');
    writeFileSync(join(deps, 'lochub_web.js'), 'must never win over the web root');
    const app = Fastify();
    registerWebApp(app, dist, deps);
    const chunk = await app.inject({ method: 'GET', url: '/lochub_web_deps.js' });
    expect(chunk.statusCode).toBe(200);
    expect(chunk.headers['content-type']).toContain('text/javascript');
    expect(chunk.headers['cache-control']).toBe('no-cache');
    expect(chunk.body).toContain('vendor');
    expect((await app.inject({ method: 'GET', url: '/lochub_web.js' })).body).toBe('console.log(2)');
  });

  it('never serves a file outside the deps folder either', async () => {
    const dist = makeDist();
    const depsParent = mkdtempSync(join(tmpdir(), 'lochub-web-deps-'));
    mkdirSync(join(depsParent, 'deps'));
    writeFileSync(join(depsParent, 'secret.txt'), 'outside');
    const app = Fastify();
    registerWebApp(app, dist, join(depsParent, 'deps'));
    expect((await app.inject({ method: 'GET', url: '/..%2Fsecret.txt' })).statusCode).toBe(404);
  });
});
