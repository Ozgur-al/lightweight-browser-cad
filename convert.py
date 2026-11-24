"""Convert a STEP assembly to a browser-ready GLB using local OpenCascade."""
import argparse
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent / '.local-ocp'))

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
from OCP.XCAFDoc import XCAFDoc_DocumentTool


def convert(source, output, deflection, angle):
    document = TDocStd_Document(TCollection_ExtendedString('MDTV-XCAF'))
    reader = STEPCAFControl_Reader()
    reader.SetNameMode(True)
    reader.SetColorMode(True)
    print(f'Reading {source.name} ({source.stat().st_size / 1e6:.0f} MB)', flush=True)
    if reader.ReadFile(str(source)) != IFSelect_RetDone:
        raise RuntimeError('OpenCascade could not read the STEP file.')
    print('Transferring assembly and styles', flush=True)
    if not reader.Transfer(document):
        raise RuntimeError('OpenCascade could not transfer the STEP assembly.')
    del reader

    shape_tool = XCAFDoc_DocumentTool.ShapeTool_s(document.Main())
    roots = TDF_LabelSequence()
    shape_tool.GetFreeShapes(roots)
    if roots.Length() == 0:
        raise RuntimeError('The STEP file contains no transferable shapes.')
    for index in range(1, roots.Length() + 1):
        print(f'Meshing assembly root {index}/{roots.Length()} (deflection {deflection} mm)', flush=True)
        shape = shape_tool.GetShape_s(roots.Value(index))
        BRepMesh_IncrementalMesh(shape, deflection, False, angle, True)

    print('Writing GLB', flush=True)
    pending = output.with_suffix('.partial.glb')
    writer = RWGltf_CafWriter(TCollection_AsciiString(str(pending)), True)
    writer.SetNodeNameFormat(RWMesh_NameFormat_ProductOrInstance)
    writer.SetMergeFaces(True)
    writer.SetSplitIndices16(True)
    if not writer.Perform(document, TColStd_IndexedDataMapOfStringString(), Message_ProgressRange()):
        raise RuntimeError('OpenCascade could not export the GLB.')
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
