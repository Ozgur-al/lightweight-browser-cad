import { arcPoint, chamfer, cornerAt, distance, entityDistance, entityExtent, entityLimit, fillet, makeEntity, midpoint, orthoPoint, pointAtLength, readDrawing, segments, shapesInRegion, translate, trimFence, validEntity, validPoint } from './drawing-geometry.js';
import { convertCad, saveFile } from './cad-client.js';

const $ = id => document.getElementById(id);
const canvas = $('drawing-canvas');
const context = canvas.getContext('2d');
const unit = value => `${value.toFixed(3)} mm`;
const storageKey = 'cad-workspace-drawing-v1';
const palette = { normal: '#cfdef1', selected: '#75e4ff', preview: '#75e4ffa8', dimension: '#ffcc8c' };
const prompts = {
  select: ['Click a shape or drag a rectangle. Left to right selects inside. Right to left also selects touched shapes.'],
  lasso: ['Hold and drag to draw a lasso. Release to select shapes inside or touching it.'],
  line: ['Pick the start point or enter X and Y.', 'Pick the end point, or aim and type a length.'],
  rectangle: ['Pick the first corner or type X and Y.', 'Pick the opposite corner or type X and Y.'],
  square: ['Pick the first corner or type X and Y.', 'Pick the opposite corner or type X and Y.'],
  circle: ['Pick the center.', 'Pick a point on the circumference.'],
  dimension: ['Pick the first endpoint.', 'Pick the second endpoint.'],
  text: ['Enter your note, then pick its insertion point or enter X and Y.'],
  trim: ['Pick the start of the trim fence.', 'Pick the end of the fence across the line portions to remove.'],
  move: ['Pick a base point for the selection.', 'Pick where the base point should move.'],
  chamfer: ['Pick a corner where two straight edges meet.'],
  fillet: ['Set the radius, then pick a corner where two straight edges meet.'],
};

let entities = [];
let selected = new Set();
let drawingName = 'Untitled drawing';
let tool = 'select';
let anchor;
let cursor;
let pointerDown;
let frame;
let viewerModule;
let scale = 4;
let center = { x: 0, y: 0 };
let width = 0;
let height = 0;
let pixelRatio = 1;
const undo = [];
const redo = [];
const exportButtons = [...document.querySelectorAll('[data-export]')];
const menu = $('drawing-menu');
const commandButtons = [...document.querySelectorAll('[data-key]')];
const entry = $('drawing-entry');
const pointForm = $('drawing-point-form');
const lengthForm = $('drawing-length-form');
const lengthInput = lengthForm.elements.namedItem('length');
const arrayForm = $('drawing-array');
const arrayInput = $('array-value');
const arrayFields = [
  ['columns', 'Columns', 3], ['rows', 'Rows', 2], ['dx', 'X pitch (mm)', 30], ['dy', 'Y pitch (mm)', 30],
];
let pointerLocation;
let pointerWorld;
let lineAim;
let entryEdit;
let arrayState;
let editingText;
const noteText = $('note-text');
const noteHeight = $('note-height');

function drawingText() {
  return JSON.stringify({ version: 1, units: 'mm', name: drawingName, entities });
}

try {
  const saved = localStorage.getItem(storageKey);
  if (saved) {
    entities = readDrawing(saved);
    const name = JSON.parse(saved).name;
    if (typeof name === 'string' && name.trim()) drawingName = name.slice(0, 150);
  }
} catch {
  // The drawing still works when storage is unavailable or its previous contents are invalid.
}

function setWorkspace(mode) {
  const drawing = mode === 'drawing';
  if (!drawing) pointerDown = undefined;
  if (!drawing && arrayState) endArray(true);
  closeMenus();
  for (const id of ['viewer-workspace', 'filename', 'model-files']) $(id).hidden = drawing;
  for (const id of ['drawing-workspace', 'drawing-name', 'drawing-menu']) $(id).hidden = !drawing;
  for (const tab of $('workspace-modes').querySelectorAll('button')) tab.setAttribute('aria-pressed', String(tab.dataset.workspace === mode));
  if (drawing) { refreshEntry(); render(); }
  else if (!viewerModule) {
    viewerModule = import('./viewer.js').catch(error => {
      viewerModule = undefined;
      $('status').textContent = 'Could not start the 3D viewer. Restart the local launcher and refresh.';
      console.error(error);
    });
  }
}

function updatePanel(message) {
  $('drawing-name').textContent = drawingName;
  $('drawing-count').textContent = `${entities.length} ${entities.length === 1 ? 'shape' : 'shapes'} · ${selected.size} selected`;
  $('drawing-delete').disabled = selected.size === 0;
  $('drawing-apply-array').disabled = selected.size === 0;
  $('drawing-undo').disabled = undo.length === 0;
  $('drawing-redo').disabled = redo.length === 0;
  $('drawing-chamfer').hidden = tool !== 'chamfer';
  $('drawing-fillet').hidden = tool !== 'fillet';
  $('drawing-text').hidden = tool !== 'text';
  $('edit-text').disabled = selectedTextIndex() === undefined;
  $('note-apply').textContent = editingText === undefined ? 'Ready to place' : 'Update note';
  $('enter-point').disabled = !acceptsPoint() || !!arrayState;
  $('enter-length').disabled = tool !== 'line' || !anchor || !!arrayState;
  refreshEntry();
  $('drawing-status').textContent = message ?? (editingText !== undefined ? 'Edit the note and press Enter to apply.' : tool === 'move' && !selected.size ? 'Select one or more shapes before choosing Move.' : prompts[tool][anchor ? 1 : 0]);
}

function setTool(next) {
  if (arrayState) endArray(true);
  if (pointerDown?.selection) pointerDown = undefined;
  tool = next;
  editingText = undefined;
  anchor = undefined;
  cursor = undefined;
  lineAim = undefined;
  stopEntry();
  for (const button of menu.querySelectorAll('[data-tool]')) button.setAttribute('aria-pressed', String(button.dataset.tool === tool));
  updatePanel();
  if (!$('drawing-workspace').hidden) {
    if (tool === 'text') { noteText.focus({ preventScroll: true }); noteText.select(); }
    else if (tool === 'fillet') { $('fillet-radius').focus({ preventScroll: true }); $('fillet-radius').select(); }
    else canvas.focus({ preventScroll: true });
  }
  render();
}

function saveDraft() {
  try { localStorage.setItem(storageKey, drawingText()); }
  catch { return false; }
  return true;
}

function commit(next, selection = new Set(), message, name = drawingName) {
  if (next.length > entityLimit || !next.every(validEntity)) {
    updatePanel(next.length > entityLimit ? `This drawing supports up to ${entityLimit} shapes.` : 'The result has invalid or zero-length geometry. Check the input values.');
    return false;
  }
  undo.push({ entities, drawingName });
  if (undo.length > 50) undo.shift();
  redo.length = 0;
  entities = next;
  selected = selection;
  drawingName = name;
  editingText = undefined;
  anchor = undefined;
  lineAim = undefined;
  stopEntry();
  if (!saveDraft()) message = 'Browser autosave is unavailable. Use Save drawing to keep your work.';
  updatePanel(message);
  render();
  return true;
}

function restore(from, to) {
  if (!from.length) return;
  to.push({ entities, drawingName });
  ({ entities, drawingName } = from.pop());
  selected = new Set();
  editingText = undefined;
  anchor = undefined;
  lineAim = undefined;
  stopEntry();
  updatePanel(saveDraft() ? undefined : 'Browser autosave is unavailable. Use Save drawing to keep your work.');
  render();
}

const toScreen = point => ({ x: width / 2 + (point.x - center.x) * scale, y: height / 2 - (point.y - center.y) * scale });
const toWorld = (x, y) => ({ x: center.x + (x - width / 2) / scale, y: center.y - (y - height / 2) / scale });
function rawPoint(event) {
  const rect = canvas.getBoundingClientRect();
  return toWorld(event.clientX - rect.left, event.clientY - rect.top);
}

function positionPopover(panel) {
  const at = pointerLocation ?? { x: width / 2, y: height / 2 };
  const left = at.x + 16 + panel.offsetWidth <= width ? at.x + 16 : at.x - panel.offsetWidth - 16;
  const top = at.y + 18 + panel.offsetHeight <= height ? at.y + 18 : at.y - panel.offsetHeight - 12;
  panel.style.left = `${Math.max(4, left)}px`;
  panel.style.top = `${Math.max(4, top)}px`;
}

function acceptsPoint() {
  return !['select', 'lasso', 'chamfer', 'fillet'].includes(tool) && editingText === undefined && (tool !== 'move' || selected.size > 0);
}

function selectedTextIndex() {
  const index = selected.values().next().value;
  if (selected.size === 1 && entities[index]?.type === 'text') return index;
}

function noteAt(position, angle = 0) {
  const entity = { type: 'text', text: noteText.value.trim(), height: noteHeight.valueAsNumber, angle, position };
  if (noteHeight.validity.valid && validEntity(entity)) return entity;
}

function inputNumber(value) {
  const text = value.trim().replace(',', '.');
  return /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i.test(text) ? Number(text) : NaN;
}

function refreshEntry() {
  entry.hidden = !acceptsPoint() || !!arrayState;
  if (entry.hidden) return;
  const showLength = tool === 'line' && !!anchor && entryEdit !== 'point';
  pointForm.hidden = showLength;
  lengthForm.hidden = !showLength;
  if (showLength) {
    if (!entryEdit) lengthInput.value = cursor ? distance(anchor, cursor).toFixed(3) : '';
    const degrees = lineAim && Math.atan2(lineAim.y - anchor.y, lineAim.x - anchor.x) * 180 / Math.PI;
    $('drawing-angle').textContent = lineAim ? `${((degrees + 360) % 360).toFixed(1)}°` : 'Aim first';
  } else {
    $('drawing-point-stage').textContent = anchor ? 'Second point (mm)' : 'First point (mm)';
    if (!entryEdit) {
      const point = cursor ?? pointerWorld ?? anchor ?? center;
      pointForm.elements.x.value = point.x.toFixed(3);
      pointForm.elements.y.value = point.y.toFixed(3);
    }
  }
  if (!entryEdit) positionPopover(entry);
}

function stopEntry() {
  entryEdit = undefined;
  entry.classList.remove('editing');
}

function focusEntry(mode, seed) {
  if (!acceptsPoint() || arrayState || (mode === 'length' && (tool !== 'line' || !anchor))) return;
  if (mode === 'point') {
    const point = cursor ?? pointerWorld ?? anchor ?? center;
    pointForm.elements.x.value = point.x.toFixed(3);
    pointForm.elements.y.value = point.y.toFixed(3);
  } else lengthInput.value = (cursor && distance(anchor, cursor).toFixed(3)) || '';
  entryEdit = mode;
  entry.classList.add('editing');
  refreshEntry();
  positionPopover(entry);
  const input = mode === 'point' ? pointForm.elements.x : lengthInput;
  if (seed !== undefined) input.value = seed;
  input.focus({ preventScroll: true });
  if (seed === undefined) input.select();
}

function gridStep() {
  const input = $('drawing-grid-step');
  return input.validity.valid && input.valueAsNumber > 0 ? input.valueAsNumber : Number(input.defaultValue);
}

function snapPoint(point) {
  if ($('drawing-object-snap').checked) {
    let best = 12 / scale;
    let target;
    const check = candidate => {
      const gap = distance(point, candidate);
      if (gap < best) {
        best = gap;
        target = candidate;
      }
    };
    for (const entity of entities) {
      if (entity.type === 'circle' || entity.type === 'arc') {
        check(entity.center);
        if (entity.type === 'arc') for (const fraction of [0, 0.5, 1]) check(arcPoint(entity, entity.startAngle + entity.sweep * fraction));
      }
      else if (entity.type !== 'dimension' && entity.type !== 'text') {
        for (const vertex of entity.points) check(vertex);
        for (const [a, b] of segments(entity)) check(midpoint(a, b));
      }
    }
    if (target) return target;
  }
  if (!$('drawing-grid-snap').checked) return point;
  const step = gridStep();
  return { x: Math.round(point.x / step) * step, y: Math.round(point.y / step) * step };
}

function draftPoint(point) {
  if (tool === 'trim') return point;
  const snapped = snapPoint(point);
  if (tool !== 'line' || !anchor) return snapped;
  const ortho = $('drawing-ortho').checked;
  const constrained = ortho ? orthoPoint(anchor, snapped, point) : snapped;
  const aim = distance(anchor, constrained) ? constrained : ortho ? orthoPoint(anchor, point) : point;
  if (distance(anchor, aim)) lineAim = aim;
  if (entryEdit === 'length') return pointAtLength(anchor, lineAim, inputNumber(lengthInput.value)) ?? constrained;
  return constrained;
}

function hitShape(point) {
  let best = 8 / scale;
  let hit = -1;
  for (let index = entities.length - 1; index >= 0; index--) {
    const gap = entityDistance(entities[index], point);
    if (gap < best) {
      best = gap;
      hit = index;
    }
  }
  return hit;
}

function selectionOutline(gesture) {
  const { start, end, trace } = gesture;
  if (trace) return distance(trace.at(-1), end) ? [...trace, end] : trace;
  return [start, { x: end.x, y: start.y }, end, { x: start.x, y: end.y }];
}

function updateDragSelection(event) {
  const gesture = pointerDown?.selection;
  if (!gesture) return;
  const rect = canvas.getBoundingClientRect();
  const x = Math.max(0, Math.min(width, event.clientX - rect.left));
  const y = Math.max(0, Math.min(height, event.clientY - rect.top));
  gesture.end = toWorld(x, y);
  gesture.active ||= distance(gesture.start, gesture.end) * scale > 5;
  if (gesture.trace && distance(gesture.trace.at(-1), gesture.end) * scale >= 3) gesture.trace.push(gesture.end);
}

function finishDragSelection(gesture, extend) {
  if (!gesture.trace && (Math.abs(gesture.end.x - gesture.start.x) * scale < 1 || Math.abs(gesture.end.y - gesture.start.y) * scale < 1)) return;
  const outline = selectionOutline(gesture);
  if (outline.length < 3) return;
  const matches = shapesInRegion(entities, outline, !!gesture.trace || gesture.end.x < gesture.start.x, 0.5 / scale);
  selected = new Set(extend ? [...selected, ...matches] : matches);
  updatePanel();
}

function pickPoint(point, extend = false) {
  if (!validPoint(point)) {
    updatePanel('Choose a valid X and Y coordinate within the drawing range.');
    return;
  }
  if (tool === 'select' || tool === 'lasso') {
    const hit = hitShape(point);
    if (!extend) selected = new Set();
    if (hit >= 0) {
      if (selected.has(hit)) selected.delete(hit);
      else selected.add(hit);
    }
    updatePanel();
  } else if (tool === 'chamfer' || tool === 'fillet') {
    const rounded = tool === 'fillet';
    const corner = cornerAt(entities, point, 12 / scale);
    if (!corner) updatePanel('Pick a polygon corner or the shared endpoint of two lines.');
    else {
      const input = $(rounded ? 'fillet-radius' : 'chamfer-distance');
      const result = input.validity.valid && (rounded ? fillet : chamfer)(entities, corner, input.valueAsNumber);
      if (result) commit(result, new Set(), `${rounded ? 'Fillet' : 'Chamfer'} created. Pick another corner or choose a different tool.`);
      else updatePanel(rounded ? 'Enter a positive radius that fits both adjoining edges.' : 'Use a positive setback shorter than both adjoining edges. The edges must form a corner.');
    }
  } else if (tool === 'move' && !selected.size) updatePanel();
  else if (tool === 'text') {
    if (editingText !== undefined) return;
    const note = noteAt(point);
    if (note) commit([...entities, note], new Set(), 'Text placed.');
    else {
      updatePanel('Enter a note and a positive text height.');
      noteText.focus({ preventScroll: true });
    }
  } else if (!anchor) {
    anchor = point;
    lineAim = undefined;
    stopEntry();
    updatePanel();
  } else if (tool === 'move') {
    const dx = point.x - anchor.x;
    const dy = point.y - anchor.y;
    if (dx || dy) commit(entities.map((entity, index) => selected.has(index) ? translate(entity, dx, dy) : entity), selected, 'Selection moved.');
    else updatePanel('Pick a different destination point.');
  } else if (tool === 'trim') {
    const result = trimFence(entities, anchor, point);
    if (result.count) commit(result.entities, new Set(), `Trimmed ${result.count} ${result.count === 1 ? 'segment' : 'segments'}.`);
    else updatePanel('No line spans crossed. Pick a fence endpoint across the middle of an edge.');
  } else {
    const entity = makeEntity(tool, anchor, point);
    const message = tool === 'dimension' ? `Distance ${unit(distance(anchor, point))}` : undefined;
    commit([...entities, entity], new Set(), message);
  }
  render();
}

function drawEntity(entity, color) {
  if (entity.type === 'text') {
    const { x, y } = toScreen(entity.position);
    context.save();
    context.translate(x, y);
    context.rotate(-entity.angle * Math.PI / 180);
    context.font = `${Math.max(1, Math.min(1e6, entity.height * scale))}px system-ui`;
    context.textAlign = 'left';
    context.fillStyle = color;
    context.fillText(entity.text, 0, 0);
    context.restore();
    return;
  }
  context.beginPath();
  context.strokeStyle = color;
  context.lineWidth = 1.5;
  if (entity.type === 'circle' || entity.type === 'arc') {
    const { x, y } = toScreen(entity.center);
    if (entity.type === 'arc') context.arc(x, y, entity.radius * scale, -entity.startAngle, -entity.startAngle - entity.sweep, true);
    else context.arc(x, y, entity.radius * scale, 0, Math.PI * 2);
    context.stroke();
    return;
  }
  const [first, ...rest] = entity.points.map(toScreen);
  context.moveTo(first.x, first.y);
  for (const point of rest) context.lineTo(point.x, point.y);
  if (entity.type === 'path') context.closePath();
  if (entity.type === 'dimension') context.setLineDash([5, 4]);
  context.stroke();
  if (entity.type !== 'dimension') return;
  context.setLineDash([]);
  const end = rest[0];
  const { x, y } = midpoint(first, end);
  const label = unit(distance(...entity.points));
  context.font = '13px system-ui';
  context.textAlign = 'center';
  context.fillStyle = '#141d29';
  const textWidth = context.measureText(label).width;
  context.fillRect(x - textWidth / 2 - 4, y - 19, textWidth + 8, 16);
  context.fillStyle = color;
  context.fillText(label, x, y - 6);
  context.fillRect(first.x - 2, first.y - 2, 4, 4);
  context.fillRect(end.x - 2, end.y - 2, 4, 4);
}

function drawGrid() {
  const step = gridStep();
  const displayStep = step * 10 ** Math.max(0, Math.ceil(Math.log10(18 / (scale * step))));
  const low = toWorld(0, height);
  const high = toWorld(width, 0);
  context.beginPath();
  for (let x = Math.ceil(low.x / displayStep) * displayStep; x <= high.x; x += displayStep) {
    const screen = toScreen({ x, y: 0 }).x;
    context.moveTo(screen, 0);
    context.lineTo(screen, height);
  }
  for (let y = Math.ceil(low.y / displayStep) * displayStep; y <= high.y; y += displayStep) {
    const screen = toScreen({ x: 0, y }).y;
    context.moveTo(0, screen);
    context.lineTo(width, screen);
  }
  context.strokeStyle = '#253548';
  context.lineWidth = 1;
  context.stroke();
  const origin = toScreen({ x: 0, y: 0 });
  context.beginPath();
  context.moveTo(origin.x, 0);
  context.lineTo(origin.x, height);
  context.moveTo(0, origin.y);
  context.lineTo(width, origin.y);
  context.strokeStyle = '#526a83';
  context.stroke();
  if (origin.x >= 0 && origin.x < width && origin.y >= 0 && origin.y < height) {
    context.fillStyle = '#a9bfd7';
    context.font = '12px system-ui';
    context.textAlign = 'left';
    context.fillText('0, 0', origin.x + 6, origin.y + 16);
  }
}

function render() {
  if (frame || $('drawing-workspace').hidden || !context) return;
  frame = requestAnimationFrame(() => {
    frame = undefined;
    if (!width || !height || $('drawing-workspace').hidden) return;
    context.setTransform(pixelRatio, 0, 0, pixelRatio, 0, 0);
    context.clearRect(0, 0, width, height);
    drawGrid();
    entities.forEach((entity, index) => drawEntity(entity, selected.has(index) ? palette.selected : entity.type === 'dimension' ? palette.dimension : palette.normal));
    const gesture = pointerDown?.selection;
    if (gesture?.active) {
      const [first, ...rest] = selectionOutline(gesture).map(toScreen);
      const crossing = !!gesture.trace || gesture.end.x < gesture.start.x;
      context.save();
      context.beginPath();
      context.moveTo(first.x, first.y);
      for (const point of rest) context.lineTo(point.x, point.y);
      context.closePath();
      context.fillStyle = crossing ? '#4bcd9a28' : '#79baff28';
      context.strokeStyle = crossing ? '#65e8af' : '#83c6ff';
      context.lineWidth = 1.5;
      if (crossing) context.setLineDash([6, 4]);
      context.fill('evenodd');
      context.stroke();
      context.restore();
    }
    if (!cursor) return;
    if (anchor && tool === 'move') {
      for (const index of selected) drawEntity(translate(entities[index], cursor.x - anchor.x, cursor.y - anchor.y), palette.preview);
    } else if (anchor && tool === 'trim') {
      context.save();
      context.setLineDash([7, 5]);
      drawEntity({ type: 'line', points: [anchor, cursor] }, '#ffac83');
      context.restore();
    } else if (tool === 'text' && editingText === undefined) {
      const note = noteAt(cursor);
      if (note) drawEntity(note, palette.preview);
    } else if (anchor && acceptsPoint()) {
      drawEntity(makeEntity(tool, anchor, cursor), palette.preview);
    }
    const { x, y } = toScreen(cursor);
    context.strokeStyle = palette.selected;
    context.lineWidth = 1.25;
    context.strokeRect(x - 4, y - 4, 8, 8);
  });
}

function fitDrawing() {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const entity of entities) {
    for (const { x, y } of entityExtent(entity)) {
      minX = Math.min(minX, x);
      minY = Math.min(minY, y);
      maxX = Math.max(maxX, x);
      maxY = Math.max(maxY, y);
    }
  }
  center = entities.length ? { x: (minX + maxX) / 2, y: (minY + maxY) / 2 } : { x: 0, y: 0 };
  scale = entities.length ? Math.max(1e-10, Math.min(1e6, (width * 0.8) / Math.max(maxX - minX, 1e-9), (height * 0.75) / Math.max(maxY - minY, 1e-9))) : 4;
  cursor = undefined;
  render();
}

new ResizeObserver(([entry]) => {
  const { width: newWidth, height: newHeight } = entry.contentRect;
  if (!newWidth || !newHeight) return;
  const first = width === 0;
  width = newWidth;
  height = newHeight;
  pixelRatio = Math.min(devicePixelRatio, 2);
  canvas.width = Math.round(width * pixelRatio);
  canvas.height = Math.round(height * pixelRatio);
  if (first && entities.length) fitDrawing();
  else render();
  refreshEntry();
  if (!entry.hidden && entryEdit) positionPopover(entry);
  if (arrayState) positionPopover(arrayForm);
}).observe($('drawing-viewport'));

canvas.addEventListener('pointerdown', event => {
  if (arrayState || !event.isPrimary || ![0, 1, 2].includes(event.button)) return;
  pointerDown = { id: event.pointerId, x: event.clientX, y: event.clientY, center, pan: event.button !== 0 };
  if (!pointerDown.pan && (tool === 'select' || tool === 'lasso')) {
    const start = rawPoint(event);
    pointerDown.selection = { start, end: start, trace: tool === 'lasso' ? [start] : undefined };
  }
  canvas.setPointerCapture(event.pointerId);
  canvas.focus({ preventScroll: true });
});
canvas.addEventListener('pointermove', event => {
  if (arrayState || !event.isPrimary) return;
  if (pointerDown?.pan) center = { x: pointerDown.center.x - (event.clientX - pointerDown.x) / scale, y: pointerDown.center.y + (event.clientY - pointerDown.y) / scale };
  if (pointerDown?.id === event.pointerId) updateDragSelection(event);
  const bounds = canvas.getBoundingClientRect();
  pointerLocation = { x: event.clientX - bounds.left, y: event.clientY - bounds.top };
  const point = rawPoint(event);
  pointerWorld = point;
  if (tool === 'chamfer' || tool === 'fillet') cursor = cornerAt(entities, point, 12 / scale)?.corner;
  else cursor = acceptsPoint() ? draftPoint(point) : undefined;
  const coordinates = cursor ?? point;
  $('drawing-cursor').textContent = `X ${coordinates.x.toFixed(3)} · Y ${coordinates.y.toFixed(3)} mm`;
  refreshEntry();
  render();
});
canvas.addEventListener('pointerup', event => {
  if (pointerDown?.id !== event.pointerId) return;
  updateDragSelection(event);
  const gesture = pointerDown.selection;
  const click = !pointerDown.pan && Math.hypot(event.clientX - pointerDown.x, event.clientY - pointerDown.y) <= 5;
  pointerDown = undefined;
  const point = rawPoint(event);
  const bounds = canvas.getBoundingClientRect();
  pointerLocation = { x: event.clientX - bounds.left, y: event.clientY - bounds.top };
  pointerWorld = point;
  if (gesture?.active) {
    finishDragSelection(gesture, event.shiftKey);
    render();
  } else if (click) pickPoint(acceptsPoint() ? draftPoint(point) : point, event.shiftKey);
});
canvas.addEventListener('lostpointercapture', () => {
  if (pointerDown?.selection) render();
  pointerDown = undefined;
});
canvas.addEventListener('pointerleave', () => {
  if (!entryEdit && !arrayState) { cursor = undefined; render(); }
});
canvas.addEventListener('contextmenu', event => event.preventDefault());
canvas.addEventListener('wheel', event => {
  event.preventDefault();
  if (pointerDown?.selection) return;
  const point = rawPoint(event);
  const delta = event.deltaY * (event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? height : 1);
  const next = Math.max(1e-10, Math.min(1e6, scale * Math.exp(-delta * 0.0015)));
  center = { x: point.x + (center.x - point.x) * scale / next, y: point.y + (center.y - point.y) * scale / next };
  scale = next;
  if (!arrayState && acceptsPoint()) {
    cursor = draftPoint(point);
    refreshEntry();
  }
  render();
}, { passive: false });

function deleteSelection() {
  if (selected.size) commit(entities.filter((_, index) => !selected.has(index)), new Set(), 'Selection deleted.');
}

function createArray({ columns, rows, dx, dy }) {
  if (!selected.size) return false;
  if ((columns === 1 && rows === 1) || (columns > 1 && dx === 0) || (rows > 1 && dy === 0)) {
    updatePanel('Choose at least two positions and enter a nonzero pitch for each repeated axis.');
    return false;
  }
  if (entities.length + selected.size * (columns * rows - 1) > entityLimit) {
    updatePanel(`This array would exceed the ${entityLimit}-shape limit.`);
    return false;
  }
  const result = entities.slice();
  for (let row = 0; row < rows; row++) {
    for (let column = 0; column < columns; column++) {
      if (!row && !column) continue;
      for (const index of selected) result.push(translate(entities[index], column * dx, row * dy));
    }
  }
  const copies = result.length - entities.length;
  return commit(result, selected, `Array created. ${copies} ${copies === 1 ? 'copy' : 'copies'} added.`);
}

function showArrayField() {
  const { step, values } = arrayState;
  const [key, label, defaultValue] = arrayFields[step];
  const count = step < 2;
  $('array-label').textContent = label;
  $('array-step').textContent = `${step + 1} / ${arrayFields.length}`;
  $('array-back').disabled = step === 0;
  $('array-next').textContent = step === arrayFields.length - 1 ? 'Create array' : 'Next';
  arrayInput.min = count ? '1' : '';
  arrayInput.max = count ? '40' : '';
  arrayInput.step = count ? '1' : 'any';
  arrayInput.value = values[key] ?? defaultValue;
  arrayInput.setCustomValidity('');
  positionPopover(arrayForm);
  arrayInput.focus({ preventScroll: true });
  arrayInput.select();
}

function startArray() {
  if (arrayState || !selected.size) return;
  setTool('select');
  arrayState = { step: 0, values: {} };
  arrayForm.hidden = false;
  refreshEntry();
  showArrayField();
}

function endArray(canceled) {
  arrayState = undefined;
  arrayForm.hidden = true;
  if (canceled) updatePanel('Array canceled.');
  else refreshEntry();
  canvas.focus({ preventScroll: true });
}

function previousArrayField() {
  if (arrayState?.step > 0) {
    arrayState.step--;
    showArrayField();
  }
}

function setFileBusy(active) {
  $('drawing-file').disabled = active;
  $('open-drawing').disabled = active;
  for (const button of exportButtons) button.disabled = active;
}

async function exportDrawing(format) {
  const name = drawingName;
  setFileBusy(true);
  updatePanel(`Exporting ${format.toUpperCase()} locally…`);
  try {
    const response = await convertCad(`export/${format}`, drawingText());
    saveFile(await response.blob(), `${name}.${format}`);
    updatePanel(`Exported ${format.toUpperCase()}.`);
  } catch (error) {
    updatePanel(`Export failed. ${error.message}`);
  } finally {
    setFileBusy(false);
  }
}

for (const tab of $('workspace-modes').querySelectorAll('button')) tab.addEventListener('click', () => {
  const mode = tab.dataset.workspace;
  const url = new URL(location.href);
  if (mode === 'drawing') url.searchParams.set('mode', 'drawing');
  else url.searchParams.delete('mode');
  history.replaceState(null, '', url);
  setWorkspace(mode);
});
function closeMenus(except) {
  for (const details of menu.querySelectorAll('details[open]')) if (details !== except) details.open = false;
}

const shortcuts = new Map(commandButtons.map(button => [button.dataset.key, button]));
for (const button of commandButtons) {
  const key = button.dataset.key;
  button.setAttribute('aria-keyshortcuts', key.replace('Ctrl+', 'Control+'));
  button.title = `${button.textContent.trim()} (${key})`;
  if (menu.contains(button)) {
    const label = document.createElement('kbd');
    label.textContent = key;
    label.setAttribute('aria-hidden', 'true');
    button.append(label);
  }
}
menu.addEventListener('click', event => {
  const summary = event.target.closest('summary');
  if (summary) closeMenus(summary.parentElement);
  const button = event.target.closest('button');
  if (button && button.closest('details')) {
    const inMenu = menu.contains(document.activeElement);
    closeMenus();
    if (inMenu) canvas.focus({ preventScroll: true });
  }
});
menu.addEventListener('click', event => {
  if (arrayState && event.target.closest('.command-list button')) endArray(true);
}, { capture: true });
document.addEventListener('click', event => { if (!menu.contains(event.target)) closeMenus(); });

for (const button of menu.querySelectorAll('[data-tool]')) button.addEventListener('click', () => setTool(button.dataset.tool));
for (const button of menu.querySelectorAll('[data-toggle]')) {
  const checkbox = $(button.dataset.toggle);
  button.addEventListener('click', () => checkbox.click());
}
for (const id of ['drawing-ortho', 'drawing-grid-snap', 'drawing-object-snap']) {
  const checkbox = $(id);
  const update = () => {
    for (const button of menu.querySelectorAll(`[data-toggle="${id}"]`)) button.setAttribute('aria-pressed', String(checkbox.checked));
    $('ortho-indicator').textContent = $('drawing-ortho').checked ? 'Ortho on' : 'Ortho off';
    if (pointerWorld && acceptsPoint()) cursor = draftPoint(pointerWorld);
    refreshEntry();
    render();
  };
  checkbox.addEventListener('change', update);
  update();
}
$('drawing-fit').addEventListener('click', fitDrawing);
$('drawing-undo').addEventListener('click', () => restore(undo, redo));
$('drawing-redo').addEventListener('click', () => restore(redo, undo));
$('drawing-delete').addEventListener('click', deleteSelection);
$('drawing-grid-step').addEventListener('input', render);
$('drawing-apply-array').addEventListener('click', startArray);
$('array-back').addEventListener('click', previousArrayField);
$('array-cancel').addEventListener('click', () => endArray(true));
arrayInput.addEventListener('input', () => arrayInput.setCustomValidity(''));
arrayForm.addEventListener('submit', event => {
  event.preventDefault();
  if (!arrayState) return;
  const { step, values } = arrayState;
  const value = arrayInput.valueAsNumber;
  if ((step === 2 && values.columns > 1 && value === 0) || (step === 3 && values.rows > 1 && value === 0)) {
    arrayInput.setCustomValidity('Enter a nonzero pitch for a repeated axis.');
    arrayInput.reportValidity();
    return;
  }
  values[arrayFields[step][0]] = value;
  if (step < arrayFields.length - 1) {
    arrayState.step++;
    showArrayField();
  } else if (createArray(values)) endArray(false);
});
$('edit-grid').addEventListener('click', () => { $('drawing-grid-step').focus(); $('drawing-grid-step').select(); });
$('edit-setback').addEventListener('click', () => {
  setTool('chamfer');
  $('chamfer-distance').focus();
  $('chamfer-distance').select();
});
$('edit-text').addEventListener('click', () => {
  const index = selectedTextIndex();
  if (index === undefined) return;
  setTool('text');
  editingText = index;
  noteText.value = entities[index].text;
  noteHeight.value = entities[index].height;
  noteText.select();
  updatePanel();
});
$('drawing-text-form').addEventListener('input', render);
$('drawing-text-form').addEventListener('submit', event => {
  event.preventDefault();
  if (!noteText.value.trim()) { updatePanel('Enter a note.'); return; }
  if (editingText === undefined) {
    canvas.focus({ preventScroll: true });
    updatePanel('Pick the note position or enter X and Y.');
    return;
  }
  const index = editingText;
  const previous = entities[index];
  const note = previous && noteAt(previous.position, previous.angle);
  if (!note) return;
  if (commit(entities.map((entity, i) => i === index ? note : entity), selected)) {
    setTool('select');
    updatePanel('Text updated.');
  }
});
for (const id of ['drawing-grid-step', 'chamfer-distance', 'fillet-radius']) {
  $(id).addEventListener('keydown', event => {
    if (event.key === 'Enter') {
      event.preventDefault();
      if (event.target.reportValidity()) canvas.focus({ preventScroll: true });
    }
  });
}
$('enter-point').addEventListener('click', () => focusEntry('point'));
$('enter-length').addEventListener('click', () => focusEntry('length'));
entry.addEventListener('focusin', event => {
  if (event.target.matches('input')) {
    entryEdit = event.target.form === lengthForm ? 'length' : 'point';
    entry.classList.add('editing');
  }
});
pointForm.elements.x.addEventListener('keydown', event => {
  if (event.key !== 'Enter') return;
  event.preventDefault();
  if (!Number.isFinite(inputNumber(event.target.value))) {
    updatePanel('Enter a valid X coordinate.');
    return;
  }
  pointForm.elements.y.focus();
  pointForm.elements.y.select();
});
pointForm.addEventListener('submit', event => {
  event.preventDefault();
  const { elements } = event.currentTarget;
  pickPoint({ x: inputNumber(elements.x.value), y: inputNumber(elements.y.value) });
  if (!entryEdit) canvas.focus({ preventScroll: true });
});
lengthInput.addEventListener('input', () => {
  const end = anchor && pointAtLength(anchor, lineAim, inputNumber(lengthInput.value));
  if (end) { cursor = end; render(); }
});
lengthForm.addEventListener('submit', event => {
  event.preventDefault();
  if (!anchor) return;
  const endpoint = pointAtLength(anchor, lineAim, inputNumber(lengthInput.value));
  if (!endpoint) {
    updatePanel(lineAim ? 'Enter a positive line length in millimeters.' : 'Aim with the pointer or an arrow key before entering a length.');
    return;
  }
  pickPoint(endpoint);
  if (!entryEdit) canvas.focus({ preventScroll: true });
});
$('open-drawing').addEventListener('click', () => $('drawing-file').click());
$('save-drawing').addEventListener('click', () => saveFile(new Blob([drawingText()], { type: 'application/json' }), `${drawingName}.json`));
for (const button of exportButtons) button.addEventListener('click', () => exportDrawing(button.dataset.export));
$('new-drawing').addEventListener('click', () => {
  if (entities.length || drawingName !== 'Untitled drawing') commit([], new Set(), undefined, 'Untitled drawing');
  setTool('select');
  fitDrawing();
});
$('drawing-file').addEventListener('change', async event => {
  const input = event.currentTarget;
  const [file] = input.files;
  if (!file) return;
  setFileBusy(true);
  updatePanel(`Opening ${file.name} locally…`);
  try {
    const extension = file.name.split('.').pop().toLowerCase();
    if (!['json', 'dxf', 'dwg'].includes(extension)) throw new Error('Select a JSON, DXF, or DWG drawing.');
    const text = extension === 'json' ? await file.text() : await (await convertCad(`import/${extension}`, file)).text();
    const imported = readDrawing(text);
    const { skipped, approximated } = JSON.parse(text);
    const notes = [approximated && `${approximated} curved or filled entities converted to paths`, skipped && `${skipped} unsupported entities skipped`].filter(Boolean);
    const message = `Opened ${file.name}.${notes.length ? ` ${notes.join(' · ')}.` : ''}`;
    if (commit(imported, new Set(), message, file.name.replace(/\.[^.]+$/, '') || 'Untitled drawing')) fitDrawing();
  } catch (error) {
    updatePanel(error instanceof SyntaxError ? 'Could not read this drawing as JSON.' : error.message);
  } finally {
    input.value = '';
    setFileBusy(false);
  }
});

document.addEventListener('keydown', event => {
  const key = event.key.length === 1 ? event.key.toUpperCase() : event.key;
  const control = event.ctrlKey || event.metaKey;
  const binding = `${control ? 'Ctrl+' : ''}${event.shiftKey ? 'Shift+' : ''}${key}`;
  const command = shortcuts.get(binding === 'Ctrl+Shift+Z' ? 'Ctrl+Y' : binding);
  const drawing = !$('drawing-workspace').hidden;
  if (command?.dataset.workspace && !event.target.matches('input, select, textarea')) {
    event.preventDefault();
    command.click();
    return;
  }
  if (!drawing || event.altKey) return;
  if (arrayState) {
    if (key === 'Escape') { event.preventDefault(); endArray(true); }
    if (key === 'Enter' && event.shiftKey) { event.preventDefault(); previousArrayField(); }
    return;
  }
  if (key === 'Escape') {
    const openMenu = menu.querySelector('details[open]');
    event.preventDefault();
    if (pointerDown?.selection) { pointerDown = undefined; render(); }
    else if (openMenu) { closeMenus(); openMenu.querySelector('summary').focus(); }
    else if (entryEdit) { stopEntry(); updatePanel(); canvas.focus({ preventScroll: true }); }
    else if (editingText !== undefined || event.target.closest('#drawing-text-form')) setTool('select');
    else if (event.target.matches('#drawing-grid-step, #chamfer-distance, #fillet-radius')) canvas.focus({ preventScroll: true });
    else if (anchor) { anchor = undefined; lineAim = undefined; updatePanel(); render(); }
    else setTool('select');
    return;
  }
  const editing = event.target.matches('input, select, textarea');
  if (command && (!editing || ['F8', 'Ctrl+O', 'Ctrl+S'].includes(binding))) {
    event.preventDefault();
    if (!command.disabled) command.click();
    else if (command.id === 'drawing-apply-array') updatePanel('Select one or more shapes before starting an array.');
    return;
  }
  if (editing || control) return;
  const details = event.target.closest('#drawing-menu details');
  if (details && (key === 'ArrowDown' || key === 'ArrowUp')) {
    event.preventDefault();
    closeMenus(details);
    details.open = true;
    const items = [...details.querySelectorAll('button:not(:disabled)')];
    const current = items.indexOf(event.target);
    const next = current < 0 ? (key === 'ArrowDown' ? 0 : items.length - 1) : (current + (key === 'ArrowDown' ? 1 : -1) + items.length) % items.length;
    items[next]?.focus();
    return;
  }
  if (event.target !== canvas || !acceptsPoint()) return;
  const length = tool === 'line' && !!anchor;
  const direction = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, 1], ArrowDown: [0, -1] }[key];
  if (length && Array.isArray(direction)) {
    event.preventDefault();
    const [dx, dy] = direction;
    const span = Math.max(gridStep(), 30 / scale);
    lineAim = cursor = { x: anchor.x + dx * span, y: anchor.y + dy * span };
    refreshEntry();
    render();
  } else if (/^[0-9+.,-]$/.test(event.key)) {
    event.preventDefault();
    focusEntry(length ? 'length' : 'point', event.key);
  } else if (key === 'Enter' && cursor) {
    event.preventDefault();
    pickPoint(cursor);
  }
});

setTool('select');
setWorkspace(new URLSearchParams(location.search).get('mode') === 'drawing' ? 'drawing' : 'viewer');
