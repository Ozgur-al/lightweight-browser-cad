import { spawn } from 'node:child_process';
import { createReadStream, createWriteStream, existsSync } from 'node:fs';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';

const workspace = fileURLToPath(new URL('.', import.meta.url));
const bundledPython = join(workspace, 'runtime', 'python', 'python.exe');
const localPython = process.env.LOCALAPPDATA && join(process.env.LOCALAPPDATA, 'Programs', 'Python', 'Python313', 'python.exe');
const python = process.env.CAD_PYTHON || [bundledPython, localPython].find(candidate => candidate && existsSync(candidate)) || (process.platform === 'win32' ? 'python.exe' : 'python3');
const bundledDotnet = join(workspace, 'runtime', 'dotnet', 'dotnet.exe');
const bridgeDirectory = join(workspace, '.local-dwg-tool');
const [dwgBridge, ...dwgArgs] = existsSync(bundledDotnet)
  ? [bundledDotnet, join(bridgeDirectory, 'DwgBridge.dll')]
  : [join(bridgeDirectory, process.platform === 'win32' ? 'DwgBridge.exe' : 'DwgBridge')];
const jobs = {
  '/api/step': ['3d', 'input.step', 'output.glb', 'model/gltf-binary', 2 ** 31, 30 * 60_000],
  '/api/import/dxf': ['2d', 'input.dxf', 'output.json', 'application/json', 200 * 2 ** 20, 120_000],
  '/api/import/dwg': ['2d', 'input.dwg', 'output.json', 'application/json', 200 * 2 ** 20, 120_000],
  '/api/export/dxf': ['2d', 'input.json', 'output.dxf', 'application/dxf', 32 * 2 ** 20, 120_000],
  '/api/export/dwg': ['2d', 'input.json', 'output.dwg', 'application/acad', 32 * 2 ** 20, 120_000],
  '/api/export/pdf': ['2d', 'input.json', 'output.pdf', 'application/pdf', 32 * 2 ** 20, 120_000],
};
const busy = new Set();

function execute(command, args, cwd, signal) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, signal, windowsHide: true });
    let output = '';
    for (const stream of [child.stdout, child.stderr]) stream.on('data', chunk => { output = (output + chunk).slice(-8000); });
    let failure;
    child.on('error', error => { failure = error; });
    child.on('close', code => {
      if (failure?.code === 'ENOENT') reject(new Error('A local CAD converter is missing. See setup in README.md.'));
      else if (failure) reject(failure);
      else if (code === 0) resolve();
      else reject(new Error(output.trim().split(/\r?\n/).filter(Boolean).at(-1)?.slice(0, 400) || `The converter exited with code ${code}.`));
    });
  });
}

async function convert(path, input, output, directory, signal) {
  if (path === '/api/step') {
    await execute(python, ['-u', join(workspace, 'convert.py'), input, output], directory, signal);
    return;
  }
  const runPython = (operation, source, target) => execute(python, [join(workspace, 'drawing-io.py'), operation, source, target], directory, signal);
  if (path === '/api/import/dwg') {
    await execute(dwgBridge, [...dwgArgs, 'read', input, 'drawing.dxf'], directory, signal);
    await runPython('import', 'drawing.dxf', output);
  } else if (path === '/api/export/dwg') {
    await runPython('dxf', input, 'drawing.dxf');
    await execute(dwgBridge, [...dwgArgs, 'write', 'drawing.dxf', output], directory, signal);
  } else {
    await runPython(path.split('/')[2] === 'import' ? 'import' : output.split('.')[1], input, output);
  }
}

function reply(response, code, message) {
  if (response.destroyed || response.headersSent) return;
  response.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  response.end(JSON.stringify({ error: message }));
}

export async function handleCadRequest(request, response, path) {
  const job = Object.hasOwn(jobs, path) ? jobs[path] : undefined;
  if (!job) return false;
  const host = request.headers.host;
  // The HTTP server already validates the Host header and the connecting network.
  if (request.method !== 'POST' || request.headers.origin !== new URL(`http://${host}`).origin) {
    reply(response, 403, 'Open the CAD workspace at its server address.');
    return true;
  }
  const [group, input, output, type, limit, timeout] = job;
  const length = Number(request.headers['content-length']);
  if (request.headers['content-type'] !== 'application/octet-stream' || !Number.isSafeInteger(length) || length <= 0 || length > limit) {
    reply(response, 413, `Choose a nonempty file smaller than ${Math.floor(limit / 2 ** 20)} MB.`);
    return true;
  }
  if (busy.has(group)) {
    reply(response, 409, 'Another conversion is running. Retry after it finishes.');
    return true;
  }
  busy.add(group);
  const controller = new AbortController();
  const stop = () => controller.abort();
  response.once('close', stop);
  const timer = setTimeout(stop, timeout);
  let directory;
  try {
    directory = await mkdtemp(join(tmpdir(), 'cad-workspace-'));
    let received = 0;
    const sizeCheck = new Transform({ transform(chunk, _, callback) {
      received += chunk.length;
      callback(received > limit ? new Error('Upload exceeds the conversion limit.') : null, chunk);
    } });
    await pipeline(request, sizeCheck, createWriteStream(join(directory, input)), { signal: controller.signal });
    await convert(path, input, output, directory, controller.signal);
    const target = join(directory, output);
    const info = await stat(target);
    if (!info.size) throw new Error('The converter returned an empty file.');
    response.writeHead(200, { 'Content-Type': type, 'Content-Length': info.size, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
    await pipeline(createReadStream(target), response, { signal: controller.signal });
  } catch (error) {
    reply(response, controller.signal.aborted ? 408 : 422, controller.signal.aborted ? 'Conversion was canceled or timed out.' : error.message);
  } finally {
    response.removeListener('close', stop);
    clearTimeout(timer);
    busy.delete(group);
    if (directory) await rm(directory, { recursive: true, force: true, maxRetries: 2 }).catch(error => console.error('Could not clean up conversion files:', error.message));
  }
  return true;
}
