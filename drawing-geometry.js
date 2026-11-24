export const entityLimit = 5000;
const coordinateLimit = 1e9;
const tolerance = 1e-7;
const turn = 2 * Math.PI;
const wrapAngle = angle => ((angle % turn) + turn) % turn;

export const distance = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
export const midpoint = (a, b) => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });

export function orthoPoint(start, target, aim = target) {
  return Math.abs(aim.x - start.x) >= Math.abs(aim.y - start.y)
    ? { x: target.x, y: start.y }
    : { x: start.x, y: target.y };
}

export function pointAtLength(start, aim, length) {
  const span = aim && distance(start, aim);
  if (!span || !Number.isFinite(length) || length <= 0) return;
  return { x: start.x + (aim.x - start.x) / span * length, y: start.y + (aim.y - start.y) / span * length };
}

export function segments(entity) {
  if (['circle', 'arc', 'text'].includes(entity.type)) return [];
  const { points } = entity;
  if (entity.type === 'line' || entity.type === 'dimension') return [points];
  if (entity.type === 'polyline') return points.slice(1).map((end, index) => [points[index], end]);
  return polygonEdges(points);
}

const polygonEdges = points => points.map((point, index) => [point, points[(index + 1) % points.length]]);

function segmentDistance(point, a, b) {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const lengthSquared = dx * dx + dy * dy;
  const t = lengthSquared ? Math.max(0, Math.min(1, ((point.x - a.x) * dx + (point.y - a.y) * dy) / lengthSquared)) : 0;
  return distance(point, { x: a.x + t * dx, y: a.y + t * dy });
}

export function arcPoint(arc, angle) {
  return { x: arc.center.x + arc.radius * Math.cos(angle), y: arc.center.y + arc.radius * Math.sin(angle) };
}

function onArc(arc, angle) {
  const relative = wrapAngle(angle - arc.startAngle);
  return relative <= arc.sweep + tolerance || turn - relative <= tolerance;
}

export function entityDistance(entity, point) {
  if (entity.type === 'circle') return Math.abs(distance(entity.center, point) - entity.radius);
  if (entity.type === 'arc') {
    const angle = Math.atan2(point.y - entity.center.y, point.x - entity.center.x);
    if (onArc(entity, angle)) return Math.abs(distance(entity.center, point) - entity.radius);
    return Math.min(distance(point, arcPoint(entity, entity.startAngle)), distance(point, arcPoint(entity, entity.startAngle + entity.sweep)));
  }
  if (entity.type === 'text') {
    const angle = entity.angle * Math.PI / 180;
    const dx = point.x - entity.position.x;
    const dy = point.y - entity.position.y;
    const x = dx * Math.cos(angle) + dy * Math.sin(angle);
    const y = -dx * Math.sin(angle) + dy * Math.cos(angle);
    return Math.hypot(Math.max(0, -x, x - textWidth(entity)), Math.max(0, -entity.height / 4 - y, y - entity.height));
  }
  return Math.min(...segments(entity).map(([a, b]) => segmentDistance(point, a, b)));
}

const textWidth = entity => entity.height * entity.text.length * 0.65;

export function entityExtent(entity) {
  if (entity.type === 'arc') {
    const cardinal = [0, Math.PI / 2, Math.PI, 3 * Math.PI / 2].filter(angle => onArc(entity, angle));
    return [entity.startAngle, entity.startAngle + entity.sweep, ...cardinal].map(angle => arcPoint(entity, angle));
  }
  if (entity.type === 'circle') {
    const { center: { x, y }, radius } = entity;
    return [{ x: x - radius, y: y - radius }, { x: x + radius, y: y + radius }];
  }
  if (entity.type !== 'text') return entity.points;
  const { position, angle, height } = entity;
  const sine = Math.sin(angle * Math.PI / 180);
  const cosine = Math.cos(angle * Math.PI / 180);
  return [[0, -height / 4], [textWidth(entity), -height / 4], [textWidth(entity), height], [0, height]].map(([x, y]) => ({
    x: position.x + x * cosine - y * sine, y: position.y + x * sine + y * cosine,
  }));
}

function boundsOf(points) {
  const bounds = { left: Infinity, bottom: Infinity, right: -Infinity, top: -Infinity };
  for (const { x, y } of points) {
    bounds.left = Math.min(bounds.left, x);
    bounds.bottom = Math.min(bounds.bottom, y);
    bounds.right = Math.max(bounds.right, x);
    bounds.top = Math.max(bounds.top, y);
  }
  return bounds;
}

function containsPoint(edges, point, epsilon) {
  let inside = false;
  for (const [a, b] of edges) {
    if (segmentDistance(point, a, b) <= epsilon) return true;
    if ((a.y > point.y) !== (b.y > point.y) && point.x < a.x + (b.x - a.x) * (point.y - a.y) / (b.y - a.y)) inside = !inside;
  }
  return inside;
}

function intersects(a, b, c, d, epsilon) {
  const cross = (start, end, point) => (end.x - start.x) * (point.y - start.y) - (end.y - start.y) * (point.x - start.x);
  if ([a, b].some(point => segmentDistance(point, c, d) <= epsilon) || [c, d].some(point => segmentDistance(point, a, b) <= epsilon)) return true;
  return (cross(a, b, c) > 0) !== (cross(a, b, d) > 0) && (cross(c, d, a) > 0) !== (cross(c, d, b) > 0);
}

export function shapesInRegion(entities, outline, crossing, epsilon = tolerance) {
  if (outline.length < 3) return [];
  const boundary = polygonEdges(outline);
  const region = boundsOf(outline);
  const inside = point => containsPoint(boundary, point, epsilon);
  const matches = [];
  entities.forEach((entity, index) => {
    const points = entityExtent(entity);
    const bounds = boundsOf(points);
    // A window is an axis-aligned rectangle. Extremes determine full containment.
    if (!crossing) {
      if (bounds.left >= region.left - epsilon && bounds.right <= region.right + epsilon && bounds.bottom >= region.bottom - epsilon && bounds.top <= region.top + epsilon) matches.push(index);
      return;
    }
    if (bounds.right < region.left - epsilon || bounds.left > region.right + epsilon || bounds.top < region.bottom - epsilon || bounds.bottom > region.top + epsilon) return;
    if (entity.type === 'circle') {
      const { center, radius } = entity;
      const rim = { x: bounds.right, y: center.y };
      if (inside(rim) || boundary.some(([a, b]) => segmentDistance(center, a, b) <= radius + epsilon && Math.max(distance(a, center), distance(b, center)) >= radius - epsilon)) matches.push(index);
      return;
    }
    if (entity.type === 'arc') {
      if (points.some(inside) || boundary.some(([a, b]) => curveIntersections(a, b, entity, distance(a, b)).some(t => t >= 0 && t <= 1))) matches.push(index);
      return;
    }
    const strokes = entity.type === 'text' ? polygonEdges(points) : segments(entity);
    if (points.some(inside) || strokes.some(([a, b]) => boundary.some(([c, d]) => intersects(a, b, c, d, epsilon))) || (entity.type === 'text' && containsPoint(strokes, outline[0], epsilon))) matches.push(index);
  });
  return matches;
}

function segmentIntersection(a, b, c, d) {
  const vx = b.x - a.x;
  const vy = b.y - a.y;
  const wx = d.x - c.x;
  const wy = d.y - c.y;
  const length = Math.hypot(vx, vy);
  const otherLength = Math.hypot(wx, wy);
  const cross = vx * wy - vy * wx;
  if (Math.abs(cross) <= 8 * Number.EPSILON * length * otherLength) return;
  const t = ((c.x - a.x) * wy - (c.y - a.y) * wx) / cross;
  const u = ((c.x - a.x) * vy - (c.y - a.y) * vx) / cross;
  if (t >= -tolerance / length && t <= 1 + tolerance / length && u >= -tolerance / otherLength && u <= 1 + tolerance / otherLength) return Math.max(0, Math.min(1, t));
}

function circleIntersections(a, b, circle, length) {
  if (!length) return [];
  const ux = (b.x - a.x) / length;
  const uy = (b.y - a.y) / length;
  const dx = circle.center.x - a.x;
  const dy = circle.center.y - a.y;
  const perpendicular = Math.abs(ux * dy - uy * dx);
  if (perpendicular > circle.radius) return [];
  const along = ux * dx + uy * dy;
  const offset = Math.sqrt((circle.radius - perpendicular) * (circle.radius + perpendicular));
  return [(along - offset) / length, (along + offset) / length];
}

function curveIntersections(a, b, curve, length) {
  const values = circleIntersections(a, b, curve, length);
  if (curve.type === 'circle') return values;
  return values.filter(t => onArc(curve, Math.atan2(a.y + (b.y - a.y) * t - curve.center.y, a.x + (b.x - a.x) * t - curve.center.x)));
}

function pathPieces(points) {
  const pieces = [];
  for (let first = 0; first < points.length - 1; first += 4095) {
    const piece = points.slice(first, first + 4096);
    pieces.push({ type: piece.length > 2 ? 'polyline' : 'line', points: piece });
  }
  return pieces;
}

export function trimFence(entities, start, end) {
  if (distance(start, end) <= tolerance) return { entities, count: 0 };
  const edgesByEntity = entities.map(entity => ['line', 'path', 'polyline'].includes(entity.type) ? segments(entity) : []);
  const edges = edgesByEntity.flat();
  const curves = entities.filter(entity => entity.type === 'circle' || entity.type === 'arc');
  let count = 0;
  const result = entities.flatMap((entity, index) => {
    const original = edgesByEntity[index];
    let changed = false;
    const kept = original.flatMap(edge => {
      const [a, b] = edge;
      const hit = segmentIntersection(a, b, start, end);
      const length = distance(a, b);
      const epsilon = tolerance / length;
      // A fence touching only a vertex does not identify a span on either adjoining edge.
      if (hit === undefined || hit <= epsilon || hit >= 1 - epsilon) return [edge];
      let left = 0;
      let right = 1;
      let ambiguous = false;
      const boundary = t => {
        if (t === undefined || t < 0 || t > 1) return;
        if (Math.abs(t - hit) <= epsilon) ambiguous = true;
        else if (t < hit) left = Math.max(left, t);
        else right = Math.min(right, t);
      };
      for (const other of edges) if (other !== edge) boundary(segmentIntersection(a, b, ...other));
      for (const curve of curves) for (const t of curveIntersections(a, b, curve, length)) boundary(t);
      if (ambiguous) return [edge];
      changed = true;
      count++;
      const point = t => ({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t });
      return [...(left > epsilon ? [[a, point(left)]] : []), ...(right < 1 - epsilon ? [[point(right), b]] : [])];
    });
    if (!changed) return [entity];
    const runs = [];
    for (const [a, b] of kept) {
      const run = runs.at(-1);
      if (run && distance(run.at(-1), a) <= tolerance) run.push(b);
      else runs.push([a, b]);
    }
    if (entity.type === 'path' && runs.length > 1 && distance(runs.at(-1).at(-1), runs[0][0]) <= tolerance) {
      runs[0] = [...runs.pop(), ...runs[0].slice(1)];
    }
    return runs.flatMap(points => pathPieces(points).map(piece => ({ ...entity, ...piece })));
  });
  return { entities: result, count };
}

export function translate(entity, x, y) {
  const offset = point => ({ x: point.x + x, y: point.y + y });
  if (entity.type === 'circle' || entity.type === 'arc') return { ...entity, center: offset(entity.center) };
  if (entity.type === 'text') return { ...entity, position: offset(entity.position) };
  return { ...entity, points: entity.points.map(offset) };
}

export function makeEntity(tool, a, b) {
  if (tool === 'circle') return { type: tool, center: a, radius: distance(a, b) };
  if (tool === 'line' || tool === 'dimension') return { type: tool, points: [a, b] };
  let dx = b.x - a.x;
  let dy = b.y - a.y;
  if (tool === 'square') {
    const side = Math.max(Math.abs(dx), Math.abs(dy));
    dx = (Math.sign(dx) || 1) * side;
    dy = (Math.sign(dy) || 1) * side;
  }
  return { type: 'path', points: [a, { x: a.x + dx, y: a.y }, { x: a.x + dx, y: a.y + dy }, { x: a.x, y: a.y + dy }] };
}

export function cornerAt(entities, point, radius) {
  let nearest;
  let best = radius;
  const ends = [];
  entities.forEach((entity, entityIndex) => {
    if (!['path', 'polyline', 'line'].includes(entity.type)) return;
    const points = entity.points;
    points.forEach((corner, index) => {
      const gap = distance(point, corner);
      if (gap > best) return;
      if (entity.type === 'polyline' && (index === 0 || index === points.length - 1)) return;
      if (entity.type !== 'line') {
        nearest = { corner, endA: points.at(index - 1), endB: points[(index + 1) % points.length], entityA: entityIndex, indexA: index };
        best = gap;
      } else {
        const other = ends.find(end => distance(end.corner, corner) < tolerance);
        if (other) {
          nearest = { ...other, endB: points[1 - index], entityB: entityIndex, indexB: index };
          best = gap;
        }
        ends.push({ corner, endA: points[1 - index], entityA: entityIndex, indexA: index });
      }
    });
  });
  return nearest;
}

export function chamfer(entities, corner, setback) {
  if (!corner || !Number.isFinite(setback) || setback <= 0) return;
  const { corner: start, endA, endB, entityA, entityB, indexA, indexB } = corner;
  const lengthA = distance(start, endA);
  const lengthB = distance(start, endB);
  if (setback >= Math.min(lengthA, lengthB)) return;
  const cross = (endA.x - start.x) * (endB.y - start.y) - (endA.y - start.y) * (endB.x - start.x);
  if (Math.abs(cross) <= tolerance * lengthA * lengthB) return;
  const setbackPoint = (end, length) => ({ x: start.x + (end.x - start.x) * setback / length, y: start.y + (end.y - start.y) * setback / length });
  const a = setbackPoint(endA, lengthA);
  const b = setbackPoint(endB, lengthB);
  const result = entities.slice();
  const replace = (index, vertex, ...points) => {
    const entity = entities[index];
    const next = entity.points.slice();
    next.splice(vertex, 1, ...points);
    result[index] = { ...entity, points: next };
  };
  if (entityB === undefined) replace(entityA, indexA, a, b);
  else {
    replace(entityA, indexA, a);
    replace(entityB, indexB, b);
    result.push({ type: 'line', points: [a, b] });
  }
  return result;
}

export function fillet(entities, corner, radius) {
  if (!corner || !Number.isFinite(radius) || radius <= tolerance) return;
  const { corner: start, endA, endB, entityA, entityB, indexA, indexB } = corner;
  const lengthA = distance(start, endA);
  const lengthB = distance(start, endB);
  const u = { x: (endA.x - start.x) / lengthA, y: (endA.y - start.y) / lengthA };
  const v = { x: (endB.x - start.x) / lengthB, y: (endB.y - start.y) / lengthB };
  const cross = u.x * v.y - u.y * v.x;
  if (Math.abs(cross) <= tolerance) return;
  const half = Math.atan2(Math.abs(cross), u.x * v.x + u.y * v.y) / 2;
  const setback = radius / Math.tan(half);
  if (!(setback > tolerance && setback < Math.min(lengthA, lengthB) - tolerance)) return;
  const a = { x: start.x + setback * u.x, y: start.y + setback * u.y };
  const b = { x: start.x + setback * v.x, y: start.y + setback * v.y };
  const sign = Math.sign(cross);
  const center = { x: a.x - sign * u.y * radius, y: a.y + sign * u.x * radius };
  const first = sign > 0 ? b : a;
  const arc = { type: 'arc', center, radius, startAngle: wrapAngle(Math.atan2(first.y - center.y, first.x - center.x)), sweep: Math.PI - 2 * half };
  const result = entities.slice();
  if (entityB === undefined) {
    const entity = entities[entityA];
    const before = entity.points.slice(0, indexA);
    const after = entity.points.slice(indexA + 1);
    const pieces = entity.type === 'path' ? pathPieces([b, ...after, ...before, a]) : [...pathPieces([...before, a]), ...pathPieces([b, ...after])];
    result.splice(entityA, 1, ...pieces.map(piece => ({ ...entity, ...piece })), arc);
  } else {
    for (const [index, vertex, point] of [[entityA, indexA, a], [entityB, indexB, b]]) {
      const entity = entities[index];
      const points = entity.points.slice();
      points[vertex] = point;
      result[index] = { ...entity, points };
    }
    result.push(arc);
  }
  return result;
}

export function validPoint(point) {
  return point && Number.isFinite(point.x) && Number.isFinite(point.y) && Math.max(Math.abs(point.x), Math.abs(point.y)) <= coordinateLimit;
}

export function validEntity(entity) {
  if (!entity) return false;
  if (entity.type === 'circle' || entity.type === 'arc') {
    const validRadius = validPoint(entity.center) && Number.isFinite(entity.radius) && entity.radius > tolerance && entity.radius <= coordinateLimit;
    return validRadius && (entity.type === 'circle' || (Number.isFinite(entity.startAngle) && Number.isFinite(entity.sweep) && entity.sweep > 0 && entity.sweep < turn));
  }
  if (entity.type === 'text') return validPoint(entity.position) && Number.isFinite(entity.angle) && Number.isFinite(entity.height) && entity.height > 0 && entity.height <= coordinateLimit && typeof entity.text === 'string' && entity.text.length > 0 && entity.text.length <= 1024;
  if (!['path', 'polyline', 'line', 'dimension'].includes(entity.type) || !Array.isArray(entity.points)) return false;
  const path = entity.type === 'path' || entity.type === 'polyline';
  if (entity.points.length < (entity.type === 'path' ? 3 : 2) || entity.points.length > (path ? 4096 : 2)) return false;
  return entity.points.every(validPoint) && segments(entity).every(([a, b]) => distance(a, b) > tolerance);
}

export function readDrawing(text) {
  const data = JSON.parse(text);
  if (data?.version !== 1 || data.units !== 'mm' || !Array.isArray(data.entities) || data.entities.length > entityLimit || !data.entities.every(validEntity)) {
    throw new Error('Invalid drawing. Open a millimeter drawing saved by this workspace.');
  }
  return data.entities;
}

