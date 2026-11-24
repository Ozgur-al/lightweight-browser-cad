import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { createServer } from 'node:http';
import { extname } from 'node:path';
import { spawn } from 'node:child_process';
import { BlockList } from 'node:net';
import { networkInterfaces } from 'node:os';
import { handleCadRequest } from './cad-io.mjs';

const lanFlag = process.argv.indexOf('--lan');
const sharing = lanFlag !== -1;
let address = '127.0.0.1';
const peers = new BlockList();
if (sharing) {
  const choice = process.argv[lanFlag + 1];
  const requested = choice?.startsWith('--') ? undefined : choice;
  const adapters = Object.values(networkInterfaces()).flat().filter(adapter =>
    adapter.family === 'IPv4' && !adapter.internal && adapter.cidr && /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(adapter.address));
  const adapter = requested ? adapters.find(candidate => candidate.address === requested) : adapters.length === 1 ? adapters[0] : undefined;
  if (!adapter) {
    console.error('Choose this computer’s private IPv4 address using Share Viewer.cmd <address>.');
    if (adapters.length) console.error(`Available addresses: ${adapters.map(candidate => candidate.address).join(', ')}`);
    process.exit(1);
  }
  address = adapter.address;
  const prefix = Number(adapter.cidr.split('/')[1]);
  if (!Number.isInteger(prefix) || prefix < 8 || prefix > 32) {
    console.error('The selected adapter does not have a supported subnet mask.');
    process.exit(1);
  }
  peers.addSubnet(address, prefix);
}

const types = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.glb': 'model/gltf-binary',
};
const files = new Set(['/index.html', '/viewer.css', '/viewer.js', '/drawing.js', '/drawing-geometry.js', '/cad-client.js', '/model.glb']);
if (sharing) files.delete('/model.glb');
const server = createServer(async (request, response) => {
  const port = request.socket.localPort;
  const hosts = sharing ? [address] : [address, 'localhost'];
  const allowedHost = hosts.some(host => request.headers.host === `${host}:${port}` || (port === 80 && request.headers.host === host));
  if (!allowedHost || (sharing && !peers.check(request.socket.remoteAddress))) {
    response.writeHead(403).end();
    return;
  }
  let path = request.url.split('?')[0];
  if (path.startsWith('/api/') && await handleCadRequest(request, response, path)) return;
  if (path === '/') path = '/index.html';
  const vendor = /^\/vendor\/(build|examples\/jsm)\/[\w./-]+\.js$/.test(path) && !path.split('/').includes('..');
  if ((!files.has(path) && !vendor) || !['GET', 'HEAD'].includes(request.method)) {
    response.writeHead(404).end();
    return;
  }
  const file = new URL(vendor ? path.replace('/vendor/', './node_modules/three/') : `.${path}`, import.meta.url);
  try {
    const info = await stat(file);
    if (!info.isFile()) throw new Error('Not a file');
    response.writeHead(200, {
      'Content-Type': types[extname(path)],
      'Content-Length': info.size,
      'Cache-Control': 'no-cache',
      'X-Content-Type-Options': 'nosniff',
    });
    if (request.method === 'HEAD') response.end();
    else createReadStream(file).on('error', () => response.destroy()).pipe(response);
  } catch {
    response.writeHead(404).end();
  }
});

server.listen(Number(process.env.STEP_VIEWER_PORT ?? (sharing ? 8081 : 8080)), address, () => {
  const url = `http://${address}:${server.address().port}/`;
  console.log(url);
  if (process.argv.includes('--open') && process.platform === 'win32') {
    const browser = spawn('rundll32.exe', ['url.dll,FileProtocolHandler', url], { stdio: 'ignore', windowsHide: true });
    browser.on('error', () => console.log('Open the address above in your browser.'));
    browser.unref();
  }
});
