from pathlib import Path
from zipfile import ZIP_DEFLATED, ZipFile


setup = Path(__file__).resolve().parent
root = setup.parent
output = root / 'CAD-Workspace-Windows-x64-Setup.zip'

app_files = (
    'README.md', 'Open Viewer.cmd', 'Share Viewer.cmd', 'serve.mjs', 'cad-io.mjs',
    'cad-client.js', 'convert.py', 'drawing-io.py', 'index.html', 'viewer.css',
    'viewer.js', 'drawing.js', 'drawing-geometry.js',
)
three_files = (
    'LICENSE', 'build/three.module.js', 'build/three.core.js',
    'examples/jsm/controls/OrbitControls.js', 'examples/jsm/loaders/GLTFLoader.js',
    'examples/jsm/utils/BufferGeometryUtils.js', 'examples/jsm/lines/LineMaterial.js',
    'examples/jsm/lines/LineSegmentsGeometry.js', 'examples/jsm/lines/LineSegments2.js',
)
bridge_files = ('ACadSharp.dll', 'DwgBridge.dll', 'DwgBridge.deps.json', 'DwgBridge.runtimeconfig.json')
files = {
    **{name: root / name for name in app_files},
    **{f'node_modules/three/{name}': root / 'node_modules/three' / name for name in three_files},
    **{f'.local-dwg-tool/{name}': root / '.local-dwg-tool' / name for name in bridge_files},
    **{f'windows-setup/{name}': setup / name for name in ('install.ps1', 'dependencies.json', 'ACadSharp-LICENSE.txt')},
    'Install Viewer.cmd': setup / 'Install Viewer.cmd',
}

for source in files.values():
    if not source.is_file():
        raise SystemExit(f'Missing {source.relative_to(root)}. Follow the source setup instructions in README.md.')

with ZipFile(output, 'w', ZIP_DEFLATED, compresslevel=9) as archive:
    for name, source in files.items():
        archive.write(source, 'CAD Workspace/' + name)

with ZipFile(output) as archive:
    bad_member = archive.testzip()
    if bad_member:
        raise SystemExit(f'Could not verify {bad_member}')

print(f'{output.name}: {output.stat().st_size:,} bytes')
