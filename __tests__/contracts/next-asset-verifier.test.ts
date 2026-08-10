import { execFile } from 'node:child_process';
import http from 'node:http';
import path from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const verifier = path.resolve(__dirname, '../../scripts/verify-next-assets.mjs');

async function withAssetServer(
  handler: http.RequestListener,
  run: (baseUrl: string) => Promise<void>,
): Promise<void> {
  const server = http.createServer(handler);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));

  try {
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('test server has no TCP address');
    await run(`http://127.0.0.1:${address.port}`);
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
      server.closeAllConnections();
    });
  }
}

describe('recursive Next.js asset verifier', () => {
  test('follows chunk dependencies referenced by JavaScript', async () => {
    await withAssetServer((request, response) => {
      if (request.url === '/') {
        response.end('<script src="/_next/static/chunks/root.js"></script>');
        return;
      }
      if (request.url === '/_next/static/chunks/root.js') {
        response.end('load("/_next/static/chunks/lazy.js")');
        return;
      }
      if (request.url === '/_next/static/chunks/lazy.js') {
        response.end('export default 1');
        return;
      }
      response.writeHead(404).end();
    }, async (baseUrl) => {
      const { stdout } = await execFileAsync(process.execPath, [verifier, baseUrl]);
      expect(stdout).toContain('2 個 Next.js 靜態資源皆可載入');
    });
  });

  test('fails when a recursively referenced chunk is missing', async () => {
    await withAssetServer((request, response) => {
      if (request.url === '/') {
        response.end('<script src="/_next/static/chunks/root.js"></script>');
        return;
      }
      if (request.url === '/_next/static/chunks/root.js') {
        response.end('load("/_next/static/chunks/missing.js")');
        return;
      }
      response.writeHead(404).end();
    }, async (baseUrl) => {
      await expect(execFileAsync(process.execPath, [verifier, baseUrl])).rejects.toMatchObject({
        stderr: expect.stringContaining('/_next/static/chunks/missing.js 回傳 HTTP 404'),
      });
    });
  });
});
