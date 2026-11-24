import assert from 'node:assert/strict';
import { chromium } from 'playwright-core';

const browser = await chromium.launch({
  channel: 'chrome',
  args: ['--enable-unsafe-swiftshader'],
});
try {
  const page = await browser.newPage({ viewport: { width: 1100, height: 820 } });
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(process.env.STEP_VIEWER_TEST_URL ?? 'http://127.0.0.1:8080/');
  if (process.argv[2]) await page.locator('#file').setInputFiles(process.argv[2]);
  await page.locator('#status').waitFor({ state: 'hidden', timeout: 120000 });
  const canvas = page.locator('#viewport canvas');
  await canvas.waitFor();
  const parts = page.locator('.part button');
  assert.ok(await parts.count() >= 2, 'Expected a multi-component assembly');
  const summary = await page.locator('#mesh-info').innerText();
  console.log(summary);
  const shaded = await canvas.screenshot({ timeout: 30000 });

  await page.locator('[data-axis="x"]').click();
  const coordinate = page.locator('#coordinate');
  const midpoint = Number(await coordinate.inputValue());
  assert.ok(Number.isFinite(midpoint));
  assert.ok(!(await canvas.screenshot({ timeout: 30000 })).equals(shaded), 'Section plane should change the viewport');
  await page.locator('#cut').evaluate(slider => {
    slider.value = 750;
    slider.dispatchEvent(new Event('input'));
  });
  assert.ok(Number(await coordinate.inputValue()) > midpoint);
  await coordinate.fill(String(midpoint));
  await coordinate.press('Enter');
  assert.ok(Math.abs(Number(await page.locator('#cut').inputValue()) - 500) < 0.1, 'Typed coordinate should move the section');
  await page.locator('[data-view="front"]').click();
  for (const visible of await page.locator('.part input').all()) await visible.uncheck();
  await page.locator('#pick-section').click();
  assert.match(await page.locator('#pick-hint').innerText(), /X guide/);
  const size = await canvas.boundingBox();
  await canvas.click({ position: { x: size.width * 0.58, y: size.height / 2 } });
  assert.equal(await page.locator('#pick-section').getAttribute('aria-pressed'), 'false');
  assert.ok(Number(await coordinate.inputValue()) > midpoint, 'Picking the axis guide should move the section');
  await page.locator('#show-all').click();
  await page.locator('[data-view="iso"]').click();
  await page.locator('#pick-section').click();
  await canvas.click({ position: { x: size.width * 0.46, y: size.height * 0.46 } });
  assert.equal(await page.locator('#pick-section').getAttribute('aria-pressed'), 'false', 'Picking the model should place the section');
  await page.locator('#flip').check();
  await page.locator('[data-axis="off"]').click();
  await page.locator('[data-view="iso"]').click();

  await page.locator('#mode').selectOption('ghost');
  assert.ok(!(await canvas.screenshot({ timeout: 30000 })).equals(shaded), 'Transparency should change the viewport');
  await page.locator('#mode').selectOption('edges');
  await page.getByText('Building edges…', { exact: false }).waitFor({ state: 'hidden', timeout: 120000 });
  assert.ok(!(await canvas.screenshot({ timeout: 30000 })).equals(shaded), 'Feature edges should change the viewport');
  await page.locator('#mode').selectOption('wire');
  assert.ok(!(await canvas.screenshot({ timeout: 30000 })).equals(shaded), 'Wireframe should change the viewport');
  await page.locator('#mode').selectOption('solid');

  const snap = page.locator('#measure-snap');
  const hint = page.locator('#pick-hint');
  const pick = x => canvas.click({ position: { x: size.width * x, y: size.height * 0.5 } });
  async function readDistance() {
    const match = /^Distance (\d+\.\d{3}) mm$/.exec(await hint.innerText());
    assert.ok(match, 'Expected a completed measurement');
    return Number(match[1]);
  }
  async function measureByClick(first, second = first) {
    await snap.selectOption(first);
    await page.locator('#measure').click();
    await pick(0.46);
    assert.match(await hint.innerText(), /second point/);
    await snap.selectOption(second);
    await pick(0.54);
    return readDistance();
  }

  assert.ok(await measureByClick('surface') > 0);
  const edgeDistance = await measureByClick('edge');
  const vertexDistance = await measureByClick('vertex');
  assert.notEqual(edgeDistance, vertexDistance, 'Mesh edges and vertices should provide distinct endpoints');
  await measureByClick('surface', 'vertex');

  async function marker(color) {
    const screenshot = await canvas.screenshot({ timeout: 30000 });
    return page.evaluate(async ({ png, color }) => {
      const image = new Image();
      image.src = `data:image/png;base64,${png}`;
      await image.decode();
      const context = new OffscreenCanvas(image.width, image.height).getContext('2d');
      context.drawImage(image, 0, 0);
      const { data } = context.getImageData(0, 0, image.width, image.height);
      let totalX = 0;
      let totalY = 0;
      let count = 0;
      for (let i = 0; i < data.length; i += 4) {
        if (data[i] !== color[0] || data[i + 1] !== color[1] || data[i + 2] !== color[2]) continue;
        totalX += (i / 4) % image.width;
        totalY += Math.floor(i / 4 / image.width);
        count++;
      }
      return { x: totalX / count, y: totalY / count, count };
    }, { png: screenshot.toString('base64'), color });
  }

  const cyan = [118, 239, 255];
  await snap.selectOption('vertex');
  await page.locator('#measure').click();
  const hoverPoint = { x: size.width * 0.46, y: size.height * 0.5 };
  await canvas.hover({ position: hoverPoint });
  const vertexPreview = await marker(cyan);
  assert.ok(vertexPreview.count > 0, 'Hovering a vertex should highlight it');
  await canvas.click({ position: hoverPoint });
  const endpoint = await marker([255, 212, 137]);
  assert.ok(endpoint.count > 0 && Math.hypot(endpoint.x - vertexPreview.x, endpoint.y - vertexPreview.y) <= 1,
    'The clicked endpoint should match the highlighted vertex');

  await snap.selectOption('edge');
  await canvas.hover({ position: { x: size.width * 0.54, y: size.height * 0.5 } });
  assert.ok((await marker(cyan)).count > vertexPreview.count, 'The edge highlight should extend past the point marker');
  await snap.hover();
  assert.equal((await marker(cyan)).count, 0, 'The preview should clear when leaving the viewport');
  await page.keyboard.press('Escape');

  await snap.selectOption('free');
  await page.locator('#measure').click();
  for (const point of [[0, 0, 0], [3, 4, 12]]) {
    for (const [index, axis] of ['x', 'y', 'z'].entries()) {
      await page.locator(`#measure-coordinates [name="${axis}"]`).fill(String(point[index]));
    }
    await page.getByRole('button', { name: 'Add point (mm)' }).click();
  }
  assert.equal(await readDistance(), 13);
  const normalDistance = await measureByClick('free');
  await canvas.evaluate(element => {
    const rect = element.getBoundingClientRect();
    for (let i = 0; i < 150; i++) {
      element.dispatchEvent(new WheelEvent('wheel', {
        deltaY: -120, clientX: rect.left + rect.width / 2, clientY: rect.top + rect.height / 2, cancelable: true,
      }));
    }
  });
  const zoomedDistance = await measureByClick('free');
  assert.ok(zoomedDistance > 0 && zoomedDistance < normalDistance / 2000, 'Close zoom should exceed the previous limit');
  await page.locator('#fit').click();
  await page.locator('#clear-measurement').click();
  assert.ok(await page.locator('#pick-hint').isHidden());
  await page.locator('#palette').selectOption('auto');

  await parts.last().click();
  assert.equal(await parts.last().getAttribute('aria-current'), 'true');
  await page.locator('#color').fill('#ff4466');
  assert.equal(await parts.last().locator('.swatch').evaluate(element => element.style.backgroundColor), 'rgb(255, 68, 102)');
  await page.locator('#reset-color').click();
  assert.notEqual(await page.locator('#color').inputValue(), '#ff4466');
  await page.locator('#isolate').click();
  assert.ok(await page.locator('.part input:not(:checked)').count() > 0, 'Isolation should hide other components');
  await page.locator('#show-all').click();
  assert.equal(await page.locator('.part input:not(:checked)').count(), 0);
  await page.keyboard.press('Escape');
  assert.ok(await page.locator('#inspector').isHidden());
  assert.deepEqual(errors, []);
  console.log('Browser smoke check passed');
} finally {
  await browser.close();
}
