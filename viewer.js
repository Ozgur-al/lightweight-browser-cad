import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { LineMaterial } from 'three/addons/lines/LineMaterial.js';
import { LineSegments2 } from 'three/addons/lines/LineSegments2.js';
import { LineSegmentsGeometry } from 'three/addons/lines/LineSegmentsGeometry.js';
import { convertCad, saveFile } from './cad-client.js';

const $ = id => document.getElementById(id);
const viewport = $('viewport');
const status = $('status');
const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(36, 1, 0.001, 100);
const plane = new THREE.Plane();
const bounds = new THREE.Box3();
const sphere = new THREE.Sphere();
const selectionTint = new THREE.Color('#ffcd83').multiplyScalar(0.19);
const mono = new THREE.Color('#a7b4cf');
const edgesMaterial = new THREE.LineBasicMaterial({ color: '#1a222e', transparent: true, opacity: 0.55 });
const overlay = { depthTest: false, depthWrite: false, transparent: true };
const guideStart = new THREE.Vector3();
const guideEnd = new THREE.Vector3();
const guide = new THREE.Line(new THREE.BufferGeometry().setFromPoints([guideStart, guideEnd]), new THREE.LineBasicMaterial(overlay));
const axisColors = { x: '#ff8484', y: '#91e5a2', z: '#87c5ff' };
const measurePoints = [];
const measurePlane = new THREE.Plane();
const measureGeometry = new THREE.BufferGeometry().setFromPoints([guideStart, guideEnd]);
const measureLine = new THREE.Line(measureGeometry, new THREE.LineBasicMaterial({ ...overlay, color: '#ffd489' }));
const measureMarkers = new THREE.Points(measureGeometry, new THREE.PointsMaterial({ ...overlay, color: '#ffd489', size: 7, sizeAttenuation: false }));
const snapColor = '#76efff';
const snapMarker = new THREE.Points(new THREE.BufferGeometry().setFromPoints([guideStart]),
  new THREE.PointsMaterial({ ...overlay, color: snapColor, size: 11, sizeAttenuation: false }));
const snapEdge = new LineSegments2(new LineSegmentsGeometry().setPositions([0, 0, 0, 0, 0, 0]),
  new LineMaterial({ ...overlay, color: snapColor, linewidth: 4 }));
for (const object of [guide, measureLine, measureMarkers, snapMarker, snapEdge]) {
  object.visible = false;
  object.frustumCulled = false;
  object.renderOrder = 10;
  scene.add(object);
}
snapMarker.renderOrder = 11;
const directions = {
  iso: new THREE.Vector3(1, 0.65, 1), front: new THREE.Vector3(0, 0, 1),
  top: new THREE.Vector3(0, 1, 0.0001), side: new THREE.Vector3(1, 0, 0),
};

let renderer;
try {
  renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
} catch (error) {
  status.textContent = 'This viewer needs WebGL 2. Try a browser with hardware acceleration enabled.';
  throw error;
}
renderer.localClippingEnabled = true;
renderer.setPixelRatio(Math.min(devicePixelRatio, 1.75));
renderer.domElement.setAttribute('aria-label', 'Interactive model');
viewport.prepend(renderer.domElement);

camera.position.copy(directions.iso);
const controls = new OrbitControls(camera, renderer.domElement);
controls.zoomToCursor = true;
const key = new THREE.DirectionalLight(0xffffff, 2.2);
key.position.set(4, 6, 5);
const fill = new THREE.DirectionalLight(0xb0cdff, 1.3);
fill.position.set(-4, 2, -5);
scene.add(key, fill, new THREE.HemisphereLight(0xf3f7ff, 0x687787, 1.7));

let root;
let entries = [];
let leaves = [];
let selected;
let axis = 'off';
let pickMode;
let request = 0;
let edgeJob = 0;
let frame;
let pendingSnap;
let previewSnap;
let convertedModel;
let stepConversion;

function render() {
  if (frame) return;
  frame = requestAnimationFrame(() => {
    frame = undefined;
    if (root) {
      const near = THREE.MathUtils.clamp(camera.position.distanceTo(controls.target) / 20,
        controls.minDistance / 100, sphere.radius / 3000);
      if (camera.near !== near) {
        camera.near = near;
        camera.updateProjectionMatrix();
      }
    }
    updateSnapPreview();
    renderer.render(scene, camera);
  });
}

controls.addEventListener('change', () => {
  clearSnapPreview();
  render();
});
renderer.domElement.addEventListener('pointermove', event => {
  // OrbitControls suppresses sub-millimeter translation events at high magnification.
  if (event.buttons || event.pointerType === 'touch') render();
});
new ResizeObserver(() => {
  const { clientWidth: width, clientHeight: height } = viewport;
  if (!width || !height) return;
  renderer.setSize(width, height, false);
  camera.aspect = width / height;
  camera.updateProjectionMatrix();
  clearSnapPreview();
  render();
}).observe(viewport);

function fit(direction = camera.position.clone().sub(controls.target)) {
  if (!root) return;
  const vertical = THREE.MathUtils.degToRad(camera.fov / 2);
  const horizontal = Math.atan(Math.tan(vertical) * camera.aspect);
  const radius = Math.max(sphere.radius, 1e-6);
  const distance = 1.08 * radius / Math.sin(Math.min(vertical, horizontal));
  controls.target.copy(sphere.center);
  camera.position.copy(sphere.center).addScaledVector(direction.clone().normalize(), distance);
  camera.near = radius / 3000;
  camera.far = distance + radius * 150;
  controls.minDistance = radius / 1e6;
  controls.maxDistance = distance + radius * 50;
  camera.updateProjectionMatrix();
  controls.update();
  render();
}

function partColor(part) {
  if (part.override) return part.override;
  if ($('palette').value === 'auto') return part.auto;
  if ($('palette').value === 'mono') return mono;
  return part.materials[0].original;
}

function updateAppearance() {
  const mode = $('mode').value;
  const ghost = mode === 'ghost';
  const clipping = axis === 'off' || pickMode === 'section' ? [] : [plane];
  edgesMaterial.clippingPlanes = clipping;
  for (const part of leaves) {
    const color = partColor(part);
    const highlight = selected?.parts.includes(part);
    const useOriginal = !part.override && $('palette').value === 'cad';
    for (const { material, original, emissive, opacity, transparent, depthWrite } of part.materials) {
      material.color.copy(useOriginal ? original : color);
      if (emissive) {
        material.emissive.copy(emissive);
        if (highlight) material.emissive.add(selectionTint);
      }
      material.opacity = ghost ? opacity * 0.24 : opacity;
      if (material.transparent !== (ghost || transparent)) {
        material.transparent = ghost || transparent;
        material.needsUpdate = true;
      }
      material.depthWrite = !ghost && depthWrite;
      material.wireframe = mode === 'wire';
      material.clippingPlanes = clipping;
    }
  }
  for (const entry of entries) {
    entry.swatch.style.background = `#${partColor(entry.parts[0]).getHexString()}`;
    entry.button.setAttribute('aria-current', String(entry === selected));
  }
  if (selected) $('color').value = `#${partColor(selected.parts[0]).getHexString()}`;
  render();
}

async function updateEdges() {
  const job = ++edgeJob;
  const show = $('mode').value === 'edges';
  for (const { edges } of leaves) for (const line of edges) line.visible = show;
  render();
  if (!show || !root) {
    $('mesh-info').textContent = root?.userData.summary ?? '';
    return;
  }
  const cache = root.userData.edgeCache;
  $('mesh-info').textContent = `${root.userData.summary} · Building edges…`;
  for (const part of leaves) {
    for (const mesh of part.meshes.slice(part.edges.length)) {
      await new Promise(resolve => requestAnimationFrame(resolve));
      if (job !== edgeJob) return;
      // shortcut: derive feature edges from the mesh, export CAD curves if exact seams are needed.
      if (!cache.has(mesh.geometry)) cache.set(mesh.geometry, new THREE.EdgesGeometry(mesh.geometry, 23));
      const line = new THREE.LineSegments(cache.get(mesh.geometry), edgesMaterial);
      line.layers.mask = mesh.layers.mask;
      mesh.add(line);
      part.edges.push(line);
      render();
    }
  }
  $('mesh-info').textContent = root.userData.summary;
}

function updateCut() {
  clearSnapPreview();
  const active = axis !== 'off' && !!root;
  $('coordinate').disabled = !active;
  $('cut').disabled = !active;
  $('flip').disabled = !active;
  $('pick-section').disabled = !active;
  guide.visible = active && pickMode === 'section';
  if (!active) {
    $('coordinate').value = '';
    return;
  }
  const fraction = Number($('cut').value) / 1000;
  const position = THREE.MathUtils.lerp(bounds.min[axis], bounds.max[axis], fraction);
  const sign = $('flip').checked ? -1 : 1;
  plane.normal.set(0, 0, 0);
  plane.normal[axis] = sign;
  plane.constant = -sign * position;
  $('coordinate').value = Number((position * 1000).toFixed(3));
  if (guide.visible) {
    bounds.getCenter(guideStart);
    guideEnd.copy(guideStart);
    guideStart[axis] = bounds.min[axis];
    guideEnd[axis] = bounds.max[axis];
    guide.geometry.setFromPoints([guideStart, guideEnd]);
    guide.material.color.set(axisColors[axis]);
  }
  render();
}

function setCutPosition(position) {
  const span = bounds.max[axis] - bounds.min[axis];
  if (Number.isFinite(position) && span > 0) {
    $('cut').value = 1000 * THREE.MathUtils.clamp((position - bounds.min[axis]) / span, 0, 1);
  }
  if (Number.isFinite(position) && pickMode === 'section') setPickMode(undefined);
  else updateCut();
}

function updateMeasurement() {
  const count = measurePoints.length;
  measureGeometry.setFromPoints(measurePoints);
  measureGeometry.setDrawRange(0, count);
  measureLine.visible = count === 2;
  measureMarkers.visible = count > 0;
  $('clear-measurement').hidden = count === 0;
  updatePickHint();
  render();
}

function updatePickHint() {
  const hint = $('pick-hint');
  const measuring = pickMode === 'measure';
  const snap = $('measure-snap').value;
  $('measure-coordinates').hidden = !measuring || snap !== 'free';
  if (pickMode === 'section') {
    hint.textContent = `Click the ${axis.toUpperCase()} guide or a point on the model.`;
  } else if (measuring) {
    const next = measurePoints.length ? 'second' : 'first';
    const targets = { surface: 'on the model', edge: 'near a mesh edge', vertex: 'near a mesh vertex', free: 'in the view plane or enter X, Y, Z' };
    hint.textContent = `Pick the ${next} point ${targets[snap]}.`;
  } else if (measurePoints.length === 2) {
    const distance = measurePoints[0].distanceTo(measurePoints[1]) * 1000;
    hint.textContent = `Distance ${distance.toFixed(3)} mm`;
  } else {
    hint.textContent = '';
  }
  hint.hidden = !hint.textContent;
}

function setPickMode(mode) {
  if (pickMode === 'measure' && measurePoints.length < 2) {
    measurePoints.length = 0;
    updateMeasurement();
  }
  pickMode = mode;
  $('measure').setAttribute('aria-pressed', String(mode === 'measure'));
  $('pick-section').setAttribute('aria-pressed', String(mode === 'section'));
  renderer.domElement.classList.toggle('picking', !!mode);
  updateCut();
  updatePickHint();
  updateAppearance();
}

function pickGuide(rect) {
  if (guideStart.equals(guideEnd)) return;
  const start = guideStart.clone().project(camera);
  const end = guideEnd.clone().project(camera);
  if (Math.hypot((start.x - end.x) * rect.width, (start.y - end.y) * rect.height) < 16) return;
  const point = new THREE.Vector3();
  raycaster.ray.distanceSqToSegment(guideStart, guideEnd, undefined, point);
  const screen = point.clone().project(camera);
  if (Math.abs(screen.z) <= 1 && Math.hypot((pointer.x - screen.x) * rect.width, (pointer.y - screen.y) * rect.height) <= 24) {
    return point;
  }
}

function addMeasurePoint(point) {
  measurePoints.push(point);
  if (measurePoints.length === 2) setPickMode(undefined);
  updateMeasurement();
}

function snapFeature(hit, snap) {
  if (!hit) return;
  if (snap === 'surface') return { point: hit.point };
  if (!hit.face) return;
  const { object, face, instanceId } = hit;
  let transform = object.matrixWorld;
  if (instanceId !== undefined) {
    transform = new THREE.Matrix4();
    object.getMatrixAt(instanceId, transform);
    transform.premultiply(object.matrixWorld);
  }
  // shortcut: snap to the visible hit triangle's mesh features. Native CAD curves need separate export.
  const vertices = [face.a, face.b, face.c].map(index => object.getVertexPosition(index, new THREE.Vector3()).applyMatrix4(transform));
  const distances = vertices.map(vertex => axis === 'off' ? 0 : plane.distanceToPoint(vertex));
  let closest;
  let best = Infinity;
  for (let i = 0; i < vertices.length; i++) {
    let point = vertices[i];
    let segment;
    const distance = distances[i];
    if (snap === 'vertex') {
      if (distance < 0) continue;
    } else {
      const next = (i + 1) % vertices.length;
      const endDistance = distances[next];
      if (distance < 0 && endDistance < 0) continue;
      let end = vertices[next];
      if (distance < 0) point = point.clone().lerp(end, distance / (distance - endDistance));
      if (endDistance < 0) end = end.clone().lerp(point, endDistance / (endDistance - distance));
      segment = [point, end];
      if (!point.equals(end)) point = new THREE.Line3(point, end).closestPointToPoint(hit.point, true, new THREE.Vector3());
    }
    const gap = point.distanceToSquared(hit.point);
    if (gap < best) {
      closest = { point, segment };
      best = gap;
    }
  }
  return closest;
}

function select(entry) {
  selected = entry;
  $('inspector').hidden = !entry;
  if (entry) $('selected-name').textContent = entry.name;
  updateAppearance();
}

function updateVisibility() {
  clearSnapPreview();
  for (const part of leaves) {
    // A mesh node may be the transform parent of another selectable component.
    for (const object of [...part.meshes, ...part.edges]) object.layers.set(part.visible ? 0 : 1);
  }
  for (const entry of entries) {
    entry.checkbox.checked = entry.parts.every(part => part.visible);
    entry.checkbox.indeterminate = !entry.checkbox.checked && entry.parts.some(part => part.visible);
  }
  render();
}

function buildTree(gltf) {
  const meshParts = new Map();
  const hierarchy = [];
  let triangles = 0;

  function visit(object, container) {
    const nodeIndex = gltf.parser.associations.get(object)?.nodes;
    const definition = gltf.parser.json.nodes?.[nodeIndex];
    if (!definition) {
      for (const child of object.children) visit(child, container);
      return;
    }
    const originalName = definition.name || `Component ${nodeIndex + 1}`;
    const name = originalName.replaceAll('_', ' ');
    const entry = { name, originalName, children: [], parts: [] };
    if (definition.mesh !== undefined) {
      const meshes = object.isMesh ? [object] : object.children.filter(child => child.isMesh && gltf.parser.associations.get(child)?.nodes === undefined);
      const materials = [];
      const clones = new Map();
      for (const mesh of meshes) {
        function cloneMaterial(source) {
          if (!clones.has(source)) {
            const material = source.clone();
            clones.set(source, material);
            const emissive = material.emissive?.clone().multiplyScalar(material.emissiveIntensity);
            if (emissive) material.emissiveIntensity = 1;
            materials.push({ material, original: material.color.clone(), emissive, opacity: material.opacity, transparent: material.transparent, depthWrite: material.depthWrite });
          }
          return clones.get(source);
        }
        mesh.material = Array.isArray(mesh.material) ? mesh.material.map(cloneMaterial) : cloneMaterial(mesh.material);
        triangles += (mesh.geometry.index?.count ?? mesh.geometry.attributes.position.count) / 3;
        meshParts.set(mesh, entry);
      }
      if (meshes.length) {
        const auto = new THREE.Color().setHSL((leaves.length * 0.61803399 + 0.54) % 1, 0.51, 0.63, THREE.SRGBColorSpace);
        const part = { meshes, materials, auto, visible: true, edges: [] };
        entry.parts.push(part);
        leaves.push(part);
      }
    }
    for (const child of object.children) visit(child, entry.children);
    for (const child of entry.children) entry.parts.push(...child.parts);
    if (entry.parts.length) container.push(entry);
  }

  for (const child of gltf.scene.children) visit(child, hierarchy);
  if (!leaves.length) throw new Error('This model has no renderable mesh components.');
  const format = new Intl.NumberFormat();
  root.userData.summary = `${format.format(leaves.length)} components · ${format.format(triangles)} triangles`;
  root.userData.edgeCache = new Map();
  root.userData.meshParts = meshParts;

  function renderList(nodes) {
    const list = document.createElement('ul');
    for (const entry of nodes) {
      const item = document.createElement('li');
      const row = document.createElement('div');
      row.className = 'part';
      entry.checkbox = document.createElement('input');
      entry.checkbox.type = 'checkbox';
      entry.checkbox.setAttribute('aria-label', `Show ${entry.name}`);
      entry.checkbox.addEventListener('change', () => {
        for (const part of entry.parts) part.visible = entry.checkbox.checked;
        updateVisibility();
      });
      entry.button = document.createElement('button');
      entry.button.title = entry.originalName;
      entry.button.addEventListener('click', () => select(entry));
      entry.swatch = document.createElement('span');
      entry.swatch.className = 'swatch';
      entry.button.append(entry.swatch, entry.name);
      row.append(entry.checkbox, entry.button);
      item.append(row);
      if (entry.children.length) item.append(renderList(entry.children));
      list.append(item);
      entries.push(entry);
    }
    return list;
  }

  $('tree').replaceChildren(renderList(hierarchy));
}

function dispose(object) {
  const geometries = new Set();
  const materials = new Set();
  const textures = new Set();
  object.traverse(child => {
    if (child.geometry) geometries.add(child.geometry);
    for (const material of [].concat(child.material ?? [])) {
      if (material === edgesMaterial) continue;
      materials.add(material);
      for (const value of Object.values(material)) if (value?.isTexture) textures.add(value);
    }
  });
  for (const geometry of geometries) geometry.dispose();
  for (const material of materials) material.dispose();
  for (const texture of textures) texture.dispose();
}

async function load(url, name, local = false) {
  const current = ++request;
  status.hidden = false;
  status.textContent = `Loading ${name}…`;
  let gltf;
  try {
    gltf = await new GLTFLoader().loadAsync(url, progress => {
      if (current === request && progress.total) status.textContent = `Loading ${name} · ${Math.round(progress.loaded / progress.total * 100)}%`;
    });
    if (current !== request) {
      dispose(gltf.scene);
      return;
    }
    if (!gltf.scene.getObjectByProperty('isMesh', true)) {
      dispose(gltf.scene);
      throw new Error('This GLB contains no meshes.');
    }
    if (root) {
      scene.remove(root);
      dispose(root);
    }
    edgeJob++;
    root = gltf.scene;
    entries = [];
    leaves = [];
    selected = undefined;
    buildTree(gltf);
    scene.add(root);
    bounds.setFromObject(root);
    bounds.getBoundingSphere(sphere);
    $('filename').textContent = name;
    status.hidden = true;
    $('measure').disabled = false;
    $('measure-snap').disabled = false;
    measurePoints.length = 0;
    setPickMode(undefined);
    updateMeasurement();
    setAxis('off');
    select(undefined);
    updateVisibility();
    updateEdges();
    fit(directions.iso);
    return true;
  } catch (error) {
    if (current !== request) return;
    status.textContent = error.response?.status === 404 && !local
      ? 'No default model found. Choose Open model to load a GLB or STEP file.'
      : `Could not open ${name}. ${error.message}`;
    if (error.response?.status !== 404) console.error(error);
  } finally {
    if (local) URL.revokeObjectURL(url);
  }
}

const raycaster = new THREE.Raycaster();
const pointer = new THREE.Vector2();
const measureSnap = $('measure-snap');
const canvas = renderer.domElement;

function setRay(x, y) {
  const rect = canvas.getBoundingClientRect();
  pointer.set((x - rect.left) / rect.width * 2 - 1, 1 - (y - rect.top) / rect.height * 2);
  camera.updateMatrixWorld();
  raycaster.setFromCamera(pointer, camera);
  return rect;
}

function modelHit() {
  const hits = raycaster.intersectObjects([...root.userData.meshParts.keys()], false);
  return hits.find(result => axis === 'off' || pickMode === 'section' || plane.distanceToPoint(result.point) >= 0);
}

function clearSnapPreview() {
  pendingSnap = undefined;
  previewSnap = undefined;
  if (snapMarker.visible) {
    snapMarker.visible = false;
    snapEdge.visible = false;
    render();
  }
}

function updateSnapPreview() {
  if (!pendingSnap) return;
  const { x, y, mode } = pendingSnap;
  pendingSnap = undefined;
  setRay(x, y);
  const feature = snapFeature(modelHit(), mode);
  previewSnap = { x, y, mode, feature };
  snapMarker.visible = !!feature;
  snapEdge.visible = !!feature?.segment;
  if (!feature) return;
  snapMarker.geometry.setFromPoints([feature.point]);
  if (feature.segment) {
    const [start, end] = feature.segment;
    const { instanceStart, instanceEnd } = snapEdge.geometry.attributes;
    instanceStart.setXYZ(0, start.x, start.y, start.z);
    instanceEnd.setXYZ(0, end.x, end.y, end.z);
    instanceStart.data.needsUpdate = true;
  }
}

function queueSnapPreview(event) {
  const mode = measureSnap.value;
  if (pickMode !== 'measure' || (mode !== 'edge' && mode !== 'vertex')) return;
  pendingSnap = { x: event.clientX, y: event.clientY, mode };
  render();
}

canvas.addEventListener('pointermove', event => {
  if (event.buttons || event.pointerType === 'touch') clearSnapPreview();
  else queueSnapPreview(event);
});
canvas.addEventListener('pointerleave', clearSnapPreview);
canvas.addEventListener('pointercancel', clearSnapPreview);
canvas.addEventListener('wheel', queueSnapPreview, { passive: true });

let down;
canvas.addEventListener('pointerdown', event => {
  down = event.isPrimary && event.button === 0 ? [event.clientX, event.clientY] : undefined;
});
canvas.addEventListener('pointerup', event => {
  if (!root || !down || event.button !== 0 || Math.hypot(event.clientX - down[0], event.clientY - down[1]) > 4) return;
  const rect = setRay(event.clientX, event.clientY);
  const snap = measureSnap.value;
  if (pickMode === 'measure' && snap === 'free') {
    // Pick on a plane parallel to the screen through the first point or the orbit target.
    const normal = camera.getWorldDirection(new THREE.Vector3());
    measurePlane.setFromNormalAndCoplanarPoint(normal, measurePoints[0] ?? controls.target);
    const point = raycaster.ray.intersectPlane(measurePlane, new THREE.Vector3());
    if (point) addMeasurePoint(point);
    return;
  }
  if (pickMode === 'section') {
    const point = pickGuide(rect);
    if (point) {
      setCutPosition(point[axis]);
      return;
    }
  }
  if (pickMode === 'measure') {
    const exactPreview = previewSnap?.mode === snap && previewSnap.x === event.clientX && previewSnap.y === event.clientY;
    const feature = exactPreview ? previewSnap.feature : snapFeature(modelHit(), snap);
    clearSnapPreview();
    if (feature) addMeasurePoint(feature.point);
    return;
  }
  const hit = modelHit();
  if (pickMode === 'section') {
    if (hit) setCutPosition(hit.point[axis]);
    return;
  }
  if (hit) {
    const entry = root.userData.meshParts.get(hit.object);
    select(entry);
    entry.button.scrollIntoView({ block: 'nearest' });
  } else if (selected) select(undefined);
});

document.addEventListener('keydown', event => {
  if (event.key !== 'Escape' || $('viewer-workspace').hidden) return;
  if (pickMode) setPickMode(undefined);
  else if (selected) select(undefined);
});

function setAxis(value) {
  axis = value;
  if (axis === 'off' && pickMode === 'section') setPickMode(undefined);
  for (const button of $('axes').querySelectorAll('button')) button.setAttribute('aria-pressed', String(button.dataset.axis === axis));
  updateCut();
  updatePickHint();
  updateAppearance();
}

for (const button of document.querySelectorAll('[data-view]')) button.addEventListener('click', () => fit(directions[button.dataset.view]));
for (const button of $('axes').querySelectorAll('button')) button.addEventListener('click', () => setAxis(button.dataset.axis));
$('fit').addEventListener('click', () => fit());
$('palette').addEventListener('change', updateAppearance);
$('mode').addEventListener('change', () => { updateAppearance(); updateEdges(); });
$('cut').addEventListener('input', () => {
  if (pickMode === 'section') setPickMode(undefined);
  else updateCut();
});
$('coordinate').addEventListener('change', event => setCutPosition(event.target.valueAsNumber / 1000));
$('coordinate').addEventListener('keydown', event => {
  if (event.key === 'Enter') event.target.blur();
});
$('flip').addEventListener('change', updateCut);
$('pick-section').addEventListener('click', () => setPickMode(pickMode === 'section' ? undefined : 'section'));
$('measure').addEventListener('click', () => {
  const mode = pickMode === 'measure' ? undefined : 'measure';
  measurePoints.length = 0;
  setPickMode(mode);
  updateMeasurement();
});
measureSnap.addEventListener('change', () => {
  clearSnapPreview();
  updatePickHint();
});
$('measure-coordinates').addEventListener('submit', event => {
  event.preventDefault();
  if (pickMode !== 'measure' || $('measure-snap').value !== 'free') return;
  const values = [...event.currentTarget.querySelectorAll('input')].map(input => input.valueAsNumber / 1000);
  if (values.every(value => Number.isFinite(Math.fround(value)))) addMeasurePoint(new THREE.Vector3(...values));
});
$('clear-measurement').addEventListener('click', () => {
  measurePoints.length = 0;
  if (pickMode === 'measure') setPickMode(undefined);
  updateMeasurement();
});
$('show-all').addEventListener('click', () => {
  for (const part of leaves) part.visible = true;
  updateVisibility();
});
$('isolate').addEventListener('click', () => {
  for (const part of leaves) part.visible = selected.parts.includes(part);
  updateVisibility();
});
$('color').addEventListener('input', event => {
  for (const part of selected.parts) part.override = new THREE.Color(event.target.value);
  updateAppearance();
});
$('reset-color').addEventListener('click', () => {
  for (const part of selected.parts) part.override = undefined;
  updateAppearance();
});
async function openModel(file) {
  if (stepConversion) return;
  if (/\.glb$/i.test(file.name)) {
    if (await load(URL.createObjectURL(file), file.name, true)) {
      convertedModel = undefined;
      $('save-converted').hidden = true;
    }
    return;
  }
  if (!/\.st(e)?p$/i.test(file.name)) {
    status.hidden = false;
    status.textContent = 'Select a GLB, STP, or STEP file.';
    return;
  }
  ++request;
  const controller = new AbortController();
  stepConversion = controller;
  $('file').disabled = true;
  $('cancel-conversion').hidden = false;
  status.hidden = false;
  status.textContent = `Converting ${file.name} locally. Large assemblies can take several minutes.`;
  try {
    const response = await convertCad('step', file, controller.signal);
    const blob = await response.blob();
    $('cancel-conversion').hidden = true;
    if (await load(URL.createObjectURL(blob), file.name, true)) {
      convertedModel = { blob, name: file.name.replace(/\.[^.]+$/, '.glb') };
      $('save-converted').hidden = false;
    }
  } catch (error) {
    status.hidden = false;
    status.textContent = controller.signal.aborted ? 'STEP conversion canceled.' : `Could not convert ${file.name}. ${error.message}`;
  } finally {
    stepConversion = undefined;
    $('file').disabled = false;
    $('cancel-conversion').hidden = true;
  }
}

$('file').addEventListener('change', event => {
  const [file] = event.target.files;
  if (file) openModel(file);
  event.target.value = '';
});
$('cancel-conversion').addEventListener('click', () => stepConversion?.abort());
$('save-converted').addEventListener('click', () => {
  if (convertedModel) saveFile(convertedModel.blob, convertedModel.name);
});

load('./model.glb', 'model.glb');
