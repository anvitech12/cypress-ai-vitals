import { existsSync, readFileSync, statSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.json': 'application/json',
  '.md': 'text/markdown; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.wav': 'audio/wav',
  '.mp3': 'audio/mpeg',
};

export interface ReportServer {
  url: string;
  close(): Promise<void>;
}

/** Resolves a request path inside root, or undefined when it would leave root. */
function inside(root: string, requestPath: string): string | undefined {
  const full = path.resolve(root, `.${path.sep}${requestPath.replace(/^[/\\]+/, '')}`);
  return full === root || full.startsWith(root + path.sep) ? full : undefined;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Serves the reports folder on 127.0.0.1, so the runner panel can open a report in a new tab: browsers do not let a web
 * page such as the Cypress runner open file:// links. `/open?spec=<folder>&since=<ms>` waits until that spec's
 * latest.html is newer than `since` (it is written just after the spec ends), then redirects to it.
 */
export function startReportServer(reportsDir: string, waitMs = 15_000): Promise<ReportServer> {
  const root = path.resolve(reportsDir);
  const server = createServer(async (req, res) => {
    if (req.method !== 'GET') return void res.writeHead(405).end();
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    if (url.pathname === '/open') {
      const relative = path.posix.join(url.searchParams.get('spec') ?? '', 'latest.html');
      const file = inside(root, relative);
      const since = Number(url.searchParams.get('since') ?? 0);
      const deadline = Date.now() + waitMs;
      while (file && Date.now() < deadline && !(existsSync(file) && statSync(file).mtimeMs >= since)) await sleep(250);
      if (file && existsSync(file)) return void res.writeHead(302, { location: `/${relative.split('/').map(encodeURIComponent).join('/')}` }).end();
      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
      return void res.end('No report for this spec yet. In cypress open, reports need experimentalInteractiveRunEvents: true in cypress.config.');
    }
    const file = inside(root, decodeURIComponent(url.pathname));
    if (!file || !existsSync(file) || !statSync(file).isFile()) return void res.writeHead(404).end('Not found');
    res.writeHead(200, { 'content-type': TYPES[path.extname(file).toLowerCase()] ?? 'application/octet-stream', 'cache-control': 'no-store' });
    res.end(readFileSync(file));
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      // Do not keep Cypress's plugin process alive just for this server.
      server.unref();
      const { port } = server.address() as AddressInfo;
      resolve({ url: `http://127.0.0.1:${port}`, close: () => new Promise((done) => server.close(() => done())) });
    });
  });
}
