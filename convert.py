"""Convert a STEP assembly to a browser-ready GLB using local OpenCascade."""
import argparse
import json
import shutil
import struct
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent / '.local-ocp'))

from OCP.BRep import BRep_Builder
from OCP.BRepMesh import BRepMesh_IncrementalMesh
from OCP.IFSelect import IFSelect_RetDone
from OCP.Message import Message_ProgressRange
from OCP.RWGltf import RWGltf_CafWriter
from OCP.RWMesh import RWMesh_NameFormat_ProductOrInstance
from OCP.STEPCAFControl import STEPCAFControl_Reader
from OCP.TCollection import TCollection_AsciiString, TCollection_ExtendedString
from OCP.TColStd import TColStd_IndexedDataMapOfStringString
from OCP.TDF import TDF_LabelSequence
from OCP.TDocStd import TDocStd_Document
from OCP.TopAbs import TopAbs_SOLID
from OCP.TopExp import TopExp
from OCP.TopoDS import TopoDS_Compound
from OCP.TopTools import TopTools_IndexedMapOfShape
from OCP.XCAFDoc import XCAFDoc_DocumentTool

MESH_BATCHES = 50


def progress(stage, fraction=None):
    """Machine-readable progress line, relayed to the viewer by cad-io.mjs."""
    print(f'PROGRESS {stage}' + ('' if fraction is None else f' {fraction:.4f}'), flush=True)


def mesh(shape, deflection, angle, done, total):
    """Mesh solids in batches so progress can be reported; each batch still meshes in parallel."""
    solids = TopTools_IndexedMapOfShape()
    TopExp.MapShapes_s(shape, TopAbs_SOLID, solids)
    count = solids.Extent()
    size = max(1, -(-count // MESH_BATCHES))
    builder = BRep_Builder()
    for start in range(1, count + 1, size):
        batch = TopoDS_Compound()
        builder.MakeCompound(batch)
        for index in range(start, min(start + size, count + 1)):
            builder.Add(batch, solids.FindKey(index))
        BRepMesh_IncrementalMesh(batch, deflection, False, angle, True)
        progress('mesh', (done + min(start + size - 1, count) / max(count, 1)) / total)
    # Faces outside solids (free shells and faces); already meshed faces are skipped.
    BRepMesh_IncrementalMesh(shape, deflection, False, angle, True)


def drop_empty_primitives(path):
    """OpenCascade writes primitives with accessor -1 for parts that produced no triangles
    (curve-only or failed bodies). three.js cannot load those, so remove them."""
    with open(path, 'rb') as source:
        magic, version, _ = struct.unpack('<4sII', source.read(12))
        json_length, json_type = struct.unpack('<II', source.read(8))
        if magic != b'glTF' or json_type != 0x4E4F534A:
            raise RuntimeError('OpenCascade wrote an invalid GLB.')
        gltf = json.loads(source.read(json_length))
        accessors = len(gltf.get('accessors', []))
        valid = lambda index: isinstance(index, int) and 0 <= index < accessors
        removed = 0
        mesh_map = {}
        meshes = []
        for old, mesh in enumerate(gltf.get('meshes', [])):
            kept = [p for p in mesh['primitives']
                    if 'POSITION' in p['attributes'] and all(valid(i) for i in p['attributes'].values())
                    and ('indices' not in p or valid(p['indices']))]
            removed += len(mesh['primitives']) - len(kept)
            if kept:
                mesh['primitives'] = kept
                mesh_map[old] = len(meshes)
                meshes.append(mesh)
        if not removed:
            return 0
        gltf['meshes'] = meshes
        for node in gltf.get('nodes', []):
            if 'mesh' in node:
                if node['mesh'] in mesh_map:
                    node['mesh'] = mesh_map[node['mesh']]
                else:
                    del node['mesh']
        if not meshes:
            raise RuntimeError('The STEP file produced no meshable surfaces.')
        data = json.dumps(gltf, separators=(',', ':')).encode()
        data += b' ' * (-len(data) % 4)
        rest = source.tell()
        total = 12 + 8 + len(data) + (path.stat().st_size - rest)
        fixed = path.with_suffix('.fixed.glb')
        with open(fixed, 'wb') as target:
            target.write(struct.pack('<4sII', magic, version, total))
            target.write(struct.pack('<II', len(data), json_type))
            target.write(data)
            shutil.copyfileobj(source, target, 16 * 2**20)
    fixed.replace(path)
    return removed


def convert(source, output, deflection, angle):
    document = TDocStd_Document(TCollection_ExtendedString('MDTV-XCAF'))
    reader = STEPCAFControl_Reader()
    reader.SetNameMode(True)
    reader.SetColorMode(True)
    progress('read')
    print(f'Reading {source.name} ({source.stat().st_size / 1e6:.0f} MB)', flush=True)
    if reader.ReadFile(str(source)) != IFSelect_RetDone:
        raise RuntimeError('OpenCascade could not read the STEP file.')
    progress('transfer')
    print('Transferring assembly and styles', flush=True)
    if not reader.Transfer(document):
        raise RuntimeError('OpenCascade could not transfer the STEP assembly.')
    del reader

    shape_tool = XCAFDoc_DocumentTool.ShapeTool_s(document.Main())
    roots = TDF_LabelSequence()
    shape_tool.GetFreeShapes(roots)
    if roots.Length() == 0:
        raise RuntimeError('The STEP file contains no transferable shapes.')
    progress('mesh', 0)
    for index in range(1, roots.Length() + 1):
        print(f'Meshing assembly root {index}/{roots.Length()} (deflection {deflection} mm)', flush=True)
        mesh(shape_tool.GetShape_s(roots.Value(index)), deflection, angle, index - 1, roots.Length())

    progress('write')
    print('Writing GLB', flush=True)
    pending = output.with_suffix('.partial.glb')
    writer = RWGltf_CafWriter(TCollection_AsciiString(str(pending)), True)
    writer.SetNodeNameFormat(RWMesh_NameFormat_ProductOrInstance)
    writer.SetMergeFaces(True)
    writer.SetSplitIndices16(True)
    if not writer.Perform(document, TColStd_IndexedDataMapOfStringString(), Message_ProgressRange()):
        raise RuntimeError('OpenCascade could not export the GLB.')
    removed = drop_empty_primitives(pending)
    if removed:
        print(f'Skipped {removed} empty part(s) without surfaces', flush=True)
    pending.replace(output)
    print(f'Wrote {output} ({output.stat().st_size / 1e6:.1f} MB)', flush=True)


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('step', type=Path)
    parser.add_argument('output', type=Path, nargs='?', default=Path('model.glb'))
    parser.add_argument('--deflection', type=float, default=0.08, help='linear mesh tolerance in mm')
    parser.add_argument('--angle', type=float, default=0.5, help='angular mesh tolerance in radians')
    args = parser.parse_args()
    if not args.step.is_file() or args.output.suffix.lower() != '.glb' or not (args.deflection > 0 and args.angle > 0):
        parser.error('Supply an existing STEP file, a .glb output, and positive tolerances.')
    convert(args.step, args.output, args.deflection, args.angle)
