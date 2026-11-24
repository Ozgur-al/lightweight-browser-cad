import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { chromium } from 'playwright-core';
import { arcPoint, chamfer, cornerAt, distance, fillet, makeEntity, orthoPoint, pointAtLength, readDrawing, shapesInRegion, trimFence } from './drawing-geometry.js';

const p = (x, y) => ({ x, y });
const joint = [makeEntity('line', p(-10, 0), p(0, 0)), makeEntity('line', p(0, 0), p(0, 10))];
const corner = cornerAt(joint, p(0, 0), 0.1);
assert.deepEqual(chamfer(joint, corner, 2).map(entity => entity.points), [[p(-10, 0), p(-2, 0)], [p(0, 2), p(0, 10)], [p(-2, 0), p(0, 2)]]);
assert.equal(chamfer(joint, corner, 10), undefined);
const roundJoint = fillet(joint, corner, 2);
const roundArc = roundJoint.at(-1);
assert.equal(roundArc.type, 'arc');
assert.equal(roundArc.radius, 2);
assert.ok(distance(arcPoint(roundArc, roundArc.startAngle), roundJoint[0].points[1]) < 1e-8);
assert.ok(distance(arcPoint(roundArc, roundArc.startAngle + roundArc.sweep), roundJoint[1].points[0]) < 1e-8);
assert.equal(fillet(joint, corner, 10), undefined);
assert.throws(() => readDrawing('{"version":1,"units":"mm","entities":[{"type":"circle","radius":-3}]}'));
assert.deepEqual(orthoPoint(p(1, 2), p(6, 4)), p(6, 2));
assert.deepEqual(orthoPoint(p(1, 2), p(0, -8)), p(1, -8));
assert.deepEqual(pointAtLength(p(0, 0), p(3, 4), 10), p(6, 8));
assert.equal(pointAtLength(p(1, 2), p(1, 2), 10), undefined);
const selectionBox = [p(0, 0), p(5, 0), p(5, 5), p(0, 5)];
const selectionShapes = [
  makeEntity('line', p(1, 1), p(3, 3)),
  makeEntity('line', p(-3, 2), p(7, 2)),
  makeEntity('circle', p(5, 3), p(6, 3)),
  makeEntity('circle', p(2, 2), p(10, 2)),
  makeEntity('circle', p(2, 2), p(3, 2)),
];
assert.deepEqual(shapesInRegion(selectionShapes, selectionBox, false), [0, 4]);
assert.deepEqual(shapesInRegion(selectionShapes, selectionBox, true), [0, 1, 2, 4]);
const concaveLasso = [p(0, 0), p(5, 0), p(5, 1), p(1, 1), p(1, 5), p(0, 5)];
assert.deepEqual(shapesInRegion([makeEntity('circle', p(3, 3), p(3.5, 3))], concaveLasso, true), []);
const target = makeEntity('line', p(-20, 0), p(20, 0));
const cutLeft = makeEntity('line', p(-10, -5), p(-10, 5));
const cutRight = makeEntity('line', p(10, -5), p(10, 5));
const fenceStart = p(0, -2);
const fenceEnd = p(0, 2);
const trimResult = trimFence([target, cutLeft, cutRight], fenceStart, fenceEnd);
assert.equal(trimResult.count, 1);
assert.deepEqual(trimResult.entities.map(entity => entity.points), [[p(-20, 0), p(-10, 0)], [p(10, 0), p(20, 0)], cutLeft.points, cutRight.points]);
assert.deepEqual(trimFence([target], fenceStart, fenceEnd).entities, []);
const circleBoundary = makeEntity('circle', p(0, 0), p(5, 0));
assert.deepEqual(trimFence([target, circleBoundary], fenceStart, fenceEnd).entities.slice(0, 2).map(entity => entity.points), [[p(-20, 0), p(-5, 0)], [p(5, 0), p(20, 0)]]);
const box = makeEntity('rectangle', p(0, 0), p(10, 10));
const openedBox = trimFence([box], p(5, -5), p(5, 2)).entities;
assert.deepEqual(openedBox, [{ type: 'polyline', points: [p(10, 0), p(10, 10), p(0, 10), p(0, 0)] }]);

const browser = await chromium.launch({ channel: 'chrome', args: ['--enable-unsafe-swiftshader'] });
try {
  const page = await browser.newPage({ viewport: { width: 1240, height: 880 } });
  const errors = [];
  const modelRequests = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('request', request => { if (request.url().endsWith('/model.glb')) modelRequests.push(request.url()); });
  const url = new URL(process.env.STEP_VIEWER_TEST_URL ?? 'http://127.0.0.1:8080/');
  url.searchParams.set('mode', 'drawing');
  await page.goto(url.href);

  const canvas = page.locator('#drawing-canvas');
  await canvas.waitFor();
  const status = page.locator('#drawing-status');
  const form = page.locator('#drawing-point-form');
  const toolKeys = { select: 'v', line: 'l', rectangle: 'r', square: 'q', circle: 'c', dimension: 'd', move: 'm', chamfer: 'h' };
  const tool = name => page.keyboard.press(toolKeys[name]);
  const position = async (x, y) => {
    const rect = await canvas.boundingBox();
    return { x: rect.width / 2 + 4 * x, y: rect.height / 2 - 4 * y };
  };
  const pick = async (x, y) => canvas.click({ position: await position(x, y) });
  const hover = async (x, y) => canvas.hover({ position: await position(x, y) });
  async function drag(points, { add = false, cancel = false } = {}) {
    const rect = await canvas.boundingBox();
    const move = ([x, y]) => page.mouse.move(rect.x + rect.width / 2 + 4 * x, rect.y + rect.height / 2 - 4 * y, { steps: 5 });
    await move(points[0]);
    if (add) await page.keyboard.down('Shift');
    await page.mouse.down();
    for (const point of points.slice(1)) await move(point);
    if (cancel) await page.keyboard.press('Escape');
    await page.mouse.up();
    if (add) await page.keyboard.up('Shift');
  }
  const enter = async (x, y) => {
    await page.keyboard.press('p');
    await form.locator('[name="x"]').fill(String(x));
    await page.keyboard.press('Enter');
    await form.locator('[name="y"]').fill(String(y));
    await page.keyboard.press('Enter');
  };
  const drawing = () => page.evaluate(() => JSON.parse(localStorage.getItem('cad-workspace-drawing-v1')));
  async function draw(name, a, b) {
    await tool(name);
    await enter(...a);
    await enter(...b);
  }

  const drawMenu = page.locator('#drawing-menu summary', { hasText: /^Draw$/ });
  await drawMenu.focus();
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('Enter');
  assert.equal(await page.locator('[data-tool="line"]').getAttribute('aria-pressed'), 'true');
  assert.equal(await page.locator('#drawing-grid-step').inputValue(), '1');
  await hover(-49.25, 25.25);
  assert.equal(await form.locator('[name="x"]').inputValue(), '-49.000');
  await pick(-50, 25);
  await hover(-20, 35);
  await page.keyboard.type('12.5');
  await page.keyboard.press('Enter');
  assert.deepEqual((await drawing()).entities[0].points, [p(-50, 25), p(-37.5, 25)]);
  await page.keyboard.press('F8');
  assert.ok(!(await page.locator('#drawing-ortho').isChecked()));
  await pick(-60, -40);
  await hover(-45, -20);
  await page.keyboard.type('10');
  await page.keyboard.press('Enter');
  assert.deepEqual((await drawing()).entities[1].points, [p(-60, -40), p(-54, -32)]);
  await page.keyboard.press('F8');
  await enter(-75, 0);
  await page.keyboard.press('ArrowUp');
  await page.keyboard.type('8');
  await page.keyboard.press('Enter');
  assert.deepEqual((await drawing()).entities[2].points, [p(-75, 0), p(-75, 8)]);
  await page.keyboard.press('n');

  await draw('line', [-20, 0], [20, 0]);
  await draw('line', [-10, -5], [-10, 5]);
  await draw('line', [10, -5], [10, 5]);
  await page.keyboard.press('x');
  await pick(0, -2);
  await hover(0, 2);
  await pick(0, 2);
  assert.equal(await status.innerText(), 'Trimmed 1 segment.');
  assert.deepEqual((await drawing()).entities, trimResult.entities);
  await page.keyboard.press('Control+z');
  assert.deepEqual((await drawing()).entities, [target, cutLeft, cutRight]);
  await page.keyboard.press('n');

  await draw('line', [-20, -20], [-5, -20]);
  await tool('rectangle');
  await hover(20, 20);
  assert.match(await page.locator('#drawing-point-stage').innerText(), /First point/);
  assert.equal(await form.locator('[name="x"]').inputValue(), '20.000');
  await enter(20, 20);
  await hover(40, 40);
  assert.match(await page.locator('#drawing-point-stage').innerText(), /Second point/);
  assert.equal(await form.locator('[name="y"]').inputValue(), '40.000');
  await enter(40, 40);
  await draw('square', [-30, 0], [-20, 6]);
  await draw('circle', [0, 0], [10, 0]);
  assert.deepEqual((await drawing()).entities[2].points[2], p(-20, 10));
  assert.equal((await drawing()).entities[3].radius, 10);

  const selection = page.locator('#drawing-count');
  await tool('select');
  await drag([[-33, 13], [-17, -3]]);
  assert.match(await selection.innerText(), /1 selected$/);
  await drag([[-15, -17], [-10, -23]]);
  assert.match(await selection.innerText(), /0 selected$/);
  await drag([[-10, -17], [-15, -23]]);
  assert.match(await selection.innerText(), /1 selected$/);
  await page.keyboard.press('f');
  await drag([[-12, -12], [-12, 12], [12, 12], [12, -12], [-12, -12]], { add: true });
  assert.match(await selection.innerText(), /2 selected$/);
  await tool('select');
  await drag([[15, 45], [45, 15]], { cancel: true });
  assert.match(await selection.innerText(), /2 selected$/);

  await tool('chamfer');
  await pick(20, 20);
  assert.match(await status.innerText(), /Chamfer created/);
  assert.deepEqual((await drawing()).entities[1].points.slice(0, 2), [p(20, 25), p(25, 20)]);

  await tool('select');
  await pick(0, 10);
  await page.keyboard.press('a');
  const array = page.locator('#drawing-array');
  const menuAnchor = await canvas.boundingBox();
  const arrayBounds = await array.boundingBox();
  assert.ok(Math.abs(arrayBounds.x - (menuAnchor.x + menuAnchor.width / 2)) < 30);
  assert.match(await array.innerText(), /Columns/);
  await page.keyboard.press('Enter');
  assert.match(await array.innerText(), /Rows/);
  await page.keyboard.press('Shift+Enter');
  assert.match(await array.innerText(), /Columns/);
  await page.keyboard.press('Enter');
  await page.keyboard.press('Enter');
  assert.match(await array.innerText(), /X pitch/);
  await page.keyboard.press('Enter');
  assert.match(await array.innerText(), /Y pitch/);
  await page.keyboard.press('Enter');
  assert.match(await status.innerText(), /5 copies/);
  assert.deepEqual((await drawing()).entities.at(-1).center, p(60, 30));

  await tool('move');
  await enter(0, 0);
  await enter(0, -5);
  assert.deepEqual((await drawing()).entities[3].center, p(0, -5));
  await page.keyboard.press('Control+z');
  assert.deepEqual((await drawing()).entities[3].center, p(0, 0));
  await page.keyboard.press('Control+y');
  assert.deepEqual((await drawing()).entities[3].center, p(0, -5));

  await tool('dimension');
  await enter(0, 0);
  await enter(3, 4);
  assert.equal(await status.innerText(), 'Distance 5.000 mm');
  assert.equal((await drawing()).entities.length, 10);
  await page.keyboard.press('t');
  await page.locator('#note-text').fill('Plate thickness: 1.5 mm');
  await page.keyboard.press('Enter');
  await enter(-50, 40);
  assert.deepEqual((await drawing()).entities.at(-1), { type: 'text', text: 'Plate thickness: 1.5 mm', height: 3, angle: 0, position: p(-50, 40) });
  await tool('select');
  await pick(-48, 41);
  await page.keyboard.press('Shift+t');
  await page.locator('#note-text').fill('Plate thickness: 1.8 mm');
  await page.locator('#note-height').fill('4');
  await page.keyboard.press('Enter');
  assert.deepEqual((await drawing()).entities.at(-1), { type: 'text', text: 'Plate thickness: 1.8 mm', height: 4, angle: 0, position: p(-50, 40) });
  await page.keyboard.press('j');
  await page.locator('#fillet-radius').fill('2.5');
  await page.keyboard.press('Enter');
  await pick(-30, 10);
  assert.match(await status.innerText(), /^Fillet created/);
  const rounded = (await drawing()).entities.find(entity => entity.type === 'arc');
  assert.equal(rounded.radius, 2.5);
  assert.ok(distance(rounded.center, p(-27.5, 7.5)) < 1e-8);
  assert.ok(Math.abs(rounded.sweep - Math.PI / 2) < 1e-8);
  const beforeZoom = await canvas.screenshot();
  await canvas.hover({ position: { x: 350, y: 350 } });
  await page.mouse.wheel(0, -450);
  assert.ok(!(await canvas.screenshot()).equals(beforeZoom));
  await page.keyboard.press('z');

  async function download(button) {
    const pending = page.waitForEvent('download');
    if (button === 'Save drawing') await page.keyboard.press('Control+s');
    else {
      if (button !== 'Save GLB') await page.locator('#drawing-menu summary', { hasText: /^File$/ }).click();
      await page.getByRole('button', { name: button }).click();
    }
    return pending;
  }
  const saved = await download('Save drawing');
  const savedPath = await saved.path();
  assert.deepEqual(readDrawing(await readFile(savedPath, 'utf8')), (await drawing()).entities);
  const exported = await download('Export DXF');
  const dxfBytes = await readFile(await exported.path());
  const dxf = dxfBytes.toString('utf8');
  assert.match(dxf, /\r?\nCIRCLE\r?\n/);
  assert.match(dxf, /\r?\nTEXT\r?\n/);
  assert.match(dxf, /5\.000 mm/);
  const dwg = await download('Export DWG');
  const dwgBytes = await readFile(await dwg.path());
  assert.equal(dwgBytes.toString('ascii', 0, 6), 'AC1015');
  const pdf = await download('Export PDF');
  assert.match((await readFile(await pdf.path())).toString('ascii', 0, 8), /^%PDF-/);
  for (const [format, bytes] of [['dxf', dxfBytes], ['dwg', dwgBytes]]) {
    await page.locator('#drawing-file').setInputFiles({ name: `roundtrip.${format}`, mimeType: 'application/octet-stream', buffer: bytes });
    await page.waitForFunction(ext => document.getElementById('drawing-status').textContent.startsWith(`Opened roundtrip.${ext}.`), format);
    const imported = (await drawing()).entities;
    assert.equal(imported.filter(entity => entity.type === 'circle').length, 6);
    assert.equal(imported.filter(entity => entity.type === 'path').length, 1);
    assert.ok(imported.some(entity => entity.type === 'arc' && entity.radius === 2.5 && Math.abs(entity.sweep - Math.PI / 2) < 1e-8));
    assert.ok(imported.some(entity => entity.type === 'text' && entity.text === '5.000 mm'));
    assert.ok(imported.some(entity => entity.type === 'text' && entity.text === 'Plate thickness: 1.8 mm' && entity.height === 4));
  }
  assert.equal(modelRequests.length, 0, 'Direct drawing mode should run without loading the assembly');

  await page.keyboard.press('n');
  assert.equal((await drawing()).entities.length, 0);
  const selectingFile = page.waitForEvent('filechooser');
  await page.keyboard.press('Control+o');
  await (await selectingFile).setFiles({ name: saved.suggestedFilename(), mimeType: 'application/json', buffer: await readFile(savedPath) });
  await page.waitForFunction(() => document.getElementById('drawing-count').textContent.startsWith('12 shapes'));
  await page.reload();
  await canvas.waitFor();
  assert.match(await page.locator('#drawing-count').innerText(), /^12 shapes/);

  await page.getByRole('button', { name: '3D Viewer' }).click();
  await page.locator('#status').waitFor({ state: 'hidden', timeout: 120000 });
  assert.match(await page.locator('#mesh-info').innerText(), /components/);
  await page.locator('#mode').selectOption('wire');
  await page.getByRole('button', { name: '2D Drawing' }).click();
  assert.match(await page.locator('#drawing-count').innerText(), /^12 shapes/);
  await page.getByRole('button', { name: '3D Viewer' }).click();
  assert.equal(await page.locator('#mode').inputValue(), 'wire');
  assert.equal(modelRequests.length, 1);
  if (process.env.STEP_VIEWER_TEST_STEP) {
    const input = page.locator('#file');
    await input.setInputFiles(process.env.STEP_VIEWER_TEST_STEP);
    await page.locator('#save-converted').waitFor({ timeout: 120000 });
    const glb = await download('Save GLB');
    const bytes = await readFile(await glb.path());
    assert.equal(bytes.toString('ascii', 0, 4), 'glTF');
    const name = 'converted-check.glb';
    await input.setInputFiles({ name, mimeType: 'model/gltf-binary', buffer: bytes });
    await page.waitForFunction(expected => document.getElementById('filename').textContent === expected, name);
    assert.ok(await page.locator('#save-converted').isHidden());
  }
  assert.deepEqual(errors, []);
  console.log('2D drafting and workspace switching passed');
} finally {
  await browser.close();
}
