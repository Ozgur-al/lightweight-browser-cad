"""Read editable 2D geometry from DXF and write local DXF or vector PDF."""
import json
import math
import os
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent / '.local-cad'))

import ezdxf
from ezdxf import recover, units
from ezdxf.disassemble import recursive_decompose
from ezdxf.path import make_path

ENTITY_LIMIT = 5000
VERTEX_LIMIT = 4096


def read_dxf(source):
    try:
        doc = ezdxf.readfile(source)
    except (ValueError, ezdxf.DXFError):
        doc, _ = recover.readfile(source)
    factor = units.conversion_factor(doc.units, units.MM) if doc.units else 1
    entities = []
    skipped = 0
    approximated = 0

    def point(v):
        result = {'x': v[0] * factor, 'y': v[1] * factor}
        if not all(math.isfinite(n) and abs(n) <= 1e9 for n in result.values()):
            raise ValueError('A coordinate exceeds the supported range.')
        return result

    for entity in recursive_decompose(doc.modelspace()):
        kind = entity.dxftype()
        shaped = []
        try:
            if kind == 'LINE':
                a, b = point(entity.dxf.start), point(entity.dxf.end)
                if math.hypot(a['x'] - b['x'], a['y'] - b['y']) > 1e-7:
                    shaped.append({'type': 'line', 'points': [a, b]})
            elif kind == 'CIRCLE' and abs(entity.dxf.extrusion.z) > 0.999999:
                radius = entity.dxf.radius * factor
                if 1e-7 < radius <= 1e9:
                    shaped.append({'type': 'circle', 'center': point(entity.ocs().to_wcs(entity.dxf.center)), 'radius': radius})
            elif kind == 'ARC' and math.hypot(entity.dxf.extrusion.x, entity.dxf.extrusion.y) < 1e-9:
                radius = entity.dxf.radius * factor
                sweep = math.radians((entity.dxf.end_angle - entity.dxf.start_angle) % 360)
                center = point(entity.ocs().to_wcs(entity.dxf.center))
                first = point(entity.start_point if entity.dxf.extrusion.z > 0 else entity.end_point)
                angle = math.atan2(first['y'] - center['y'], first['x'] - center['x']) % math.tau
                if 1e-7 < radius <= 1e9 and 0 < sweep < math.tau:
                    shaped.append({'type': 'arc', 'center': center, 'radius': radius, 'startAngle': angle, 'sweep': sweep})
            elif kind in {'TEXT', 'ATTRIB', 'ATTDEF', 'MTEXT'}:
                if kind == 'MTEXT':
                    at = entity.dxf.insert
                    height = entity.dxf.char_height
                    angle = entity.get_rotation()
                else:
                    _, at, _ = entity.get_placement()
                    at = entity.ocs().to_wcs(at)
                    height = entity.dxf.height
                    angle = entity.dxf.rotation
                text = ' '.join(entity.plain_text().split())[:1024]
                if text and 0 < height * factor <= 1e9 and math.isfinite(angle):
                    shaped.append({'type': 'text', 'position': point(at), 'height': height * factor, 'angle': angle, 'text': text})
            elif kind in {'LWPOLYLINE', 'POLYLINE', 'ARC', 'ELLIPSE', 'SPLINE', 'CIRCLE', 'HATCH', 'SOLID', 'TRACE', '3DFACE'}:
                path = make_path(entity)
                for subpath in path.sub_paths():
                    points = []
                    for vertex in subpath.flattening(0.05 / factor):
                        value = point(vertex)
                        if not points or math.hypot(value['x'] - points[-1]['x'], value['y'] - points[-1]['y']) > 1e-7:
                            points.append(value)
                        if len(points) > VERTEX_LIMIT + 1:
                            raise ValueError('A curve exceeds the supported vertex count.')
                    closed = subpath.is_closed and len(points) > 3
                    if closed:
                        points.pop()
                    if len(points) >= (3 if closed else 2) and len(points) <= VERTEX_LIMIT:
                        shaped.append({'type': 'path' if closed else 'polyline', 'points': points})
                if shaped and (kind not in {'LWPOLYLINE', 'POLYLINE', 'SOLID', 'TRACE', '3DFACE'} or path.has_curves):
                    approximated += 1
        except (ValueError, AttributeError, TypeError, ZeroDivisionError, ezdxf.DXFError):
            shaped = []
        if not shaped:
            skipped += 1
        entities.extend(shaped)
        if len(entities) > ENTITY_LIMIT:
            raise ValueError(f'This drawing exceeds the {ENTITY_LIMIT}-shape editing limit.')
    if not entities:
        raise ValueError('This file has no supported geometry in model space.')
    return {'version': 1, 'units': 'mm', 'entities': entities, 'skipped': skipped, 'approximated': approximated}


def xy(point):
    x, y = point['x'], point['y']
    if not all(type(n) in (int, float) and math.isfinite(n) and abs(n) <= 1e9 for n in (x, y)):
        raise ValueError('Invalid point in the drawing.')
    return x, y


def features(source):
    data = json.loads(Path(source).read_text(encoding='utf-8'))
    if data['version'] != 1 or data['units'] != 'mm' or not isinstance(data['entities'], list) or len(data['entities']) > ENTITY_LIMIT:
        raise ValueError('Invalid drawing data.')
    for entity in data['entities']:
        kind = entity['type']
        if kind == 'circle':
            radius = entity['radius']
            if not math.isfinite(radius) or not 0 < radius <= 1e9:
                raise ValueError('Invalid circle radius.')
            yield kind, (xy(entity['center']), radius)
        elif kind == 'arc':
            radius, angle, sweep = entity['radius'], entity['startAngle'], entity['sweep']
            if not all(math.isfinite(n) for n in (radius, angle, sweep)) or not (0 < radius <= 1e9 and 0 < sweep < math.tau):
                raise ValueError('Invalid arc in the drawing.')
            yield kind, (xy(entity['center']), radius, angle % math.tau, sweep)
        elif kind == 'text':
            text, height, angle = entity['text'], entity['height'], entity['angle']
            if not isinstance(text, str) or len(text) > 1024 or not math.isfinite(angle) or not 0 < height <= 1e9:
                raise ValueError('Invalid annotation.')
            yield kind, (xy(entity['position']), text, height, angle % 360)
        elif kind in {'line', 'path', 'polyline', 'dimension'}:
            points = [xy(point) for point in entity['points']]
            if not (3 if kind == 'path' else 2) <= len(points) <= (VERTEX_LIMIT if kind in {'path', 'polyline'} else 2):
                raise ValueError('Invalid path in the drawing.')
            yield kind if kind != 'dimension' else 'line', points
            if kind == 'dimension':
                (x1, y1), (x2, y2) = points
                length = math.dist(*points)
                if length:
                    yield 'text', (((x1 + x2) / 2, (y1 + y2) / 2), f'{length:.3f} mm', min(3, length / 8), 0)
        else:
            raise ValueError('Unsupported drawing entity.')


def write_dxf(items, output):
    doc = ezdxf.new('R2000', units=units.MM)
    doc.header['$DIMSTYLE'] = 'Standard'
    model = doc.modelspace()
    for kind, value in items:
        if kind == 'line':
            model.add_line(*value)
        elif kind == 'circle':
            model.add_circle(*value)
        elif kind == 'arc':
            center, radius, start, sweep = value
            model.add_arc(center, radius, math.degrees(start), math.degrees(start + sweep) % 360)
        elif kind == 'text':
            point, text, height, angle = value
            model.add_text(text, dxfattribs={'insert': point, 'height': height, 'rotation': angle})
        else:
            model.add_lwpolyline(value, close=kind == 'path')
    doc.saveas(output)


def write_pdf(items, output):
    from reportlab.lib.pagesizes import A4, landscape
    from reportlab.pdfbase import pdfmetrics
    from reportlab.pdfbase.ttfonts import TTFont
    from reportlab.pdfgen.canvas import Canvas

    font = 'Helvetica'
    for candidate in [Path(os.environ.get('SystemRoot', 'C:/Windows')) / 'Fonts/arial.ttf', Path('/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf')]:
        if candidate.is_file():
            pdfmetrics.registerFont(TTFont('CADText', str(candidate)))
            font = 'CADText'
            break
    extent = []
    for kind, value in items:
        if kind == 'circle':
            (x, y), radius = value
            extent.extend([(x - radius, y - radius), (x + radius, y + radius)])
        elif kind == 'arc':
            (x, y), radius, start, sweep = value
            angles = [start, start + sweep]
            angles.extend(angle for angle in (0, math.pi / 2, math.pi, 3 * math.pi / 2) if (angle - start) % math.tau <= sweep)
            extent.extend((x + radius * math.cos(angle), y + radius * math.sin(angle)) for angle in angles)
        elif kind == 'text':
            (x, y), text, size, angle = value
            width = pdfmetrics.stringWidth(text, font, size)
            radians = math.radians(angle)
            sine, cosine = math.sin(radians), math.cos(radians)
            extent.extend((x + dx * cosine - dy * sine, y + dx * sine + dy * cosine) for dx in (0, width) for dy in (-size / 4, size))
        else:
            extent.extend(value)
    if not extent:
        raise ValueError('Draw or open a drawing before exporting a PDF.')
    xs, ys = zip(*extent)
    min_x, min_y = min(xs), min(ys)
    width, height = max(xs) - min_x, max(ys) - min_y
    page = landscape(A4) if width > height else A4
    scale = min((page[0] - 72) / max(width, 1e-9), (page[1] - 72) / max(height, 1e-9))
    pdf = Canvas(output, pagesize=page)
    pdf.setTitle('CAD drawing')
    pdf.translate((page[0] - width * scale) / 2, (page[1] - height * scale) / 2)
    pdf.scale(scale, scale)
    pdf.translate(-min_x, -min_y)
    pdf.setLineWidth(0.8 / scale)
    for kind, value in items:
        if kind == 'circle':
            (x, y), radius = value
            pdf.circle(x, y, radius)
        elif kind == 'arc':
            (x, y), radius, start, sweep = value
            pdf.arc(x - radius, y - radius, x + radius, y + radius, math.degrees(start), math.degrees(sweep))
        elif kind == 'text':
            point, text, size, angle = value
            pdf.saveState()
            pdf.translate(*point)
            pdf.rotate(angle)
            pdf.setFont(font, size)
            pdf.drawString(0, 0, text)
            pdf.restoreState()
        else:
            path = pdf.beginPath()
            path.moveTo(*value[0])
            for point in value[1:]:
                path.lineTo(*point)
            if kind == 'path':
                path.close()
            pdf.drawPath(path)
    pdf.save()


if __name__ == '__main__':
    operation, source, output = sys.argv[1:]
    try:
        if operation == 'import':
            Path(output).write_text(json.dumps(read_dxf(source), allow_nan=False), encoding='utf-8')
        elif operation == 'dxf':
            write_dxf(features(source), output)
        elif operation == 'pdf':
            write_pdf(list(features(source)), output)
    except (ValueError, KeyError, TypeError, OSError, ezdxf.DXFError) as error:
        sys.exit(str(error))
