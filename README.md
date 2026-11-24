# lightweight-browser-cad

Double-click `Open Viewer.cmd` on Windows, or run `npm start` and open `http://127.0.0.1:8080/`. The server runs on the loopback address. Switch between **3D Viewer** and **2D Drawing** in the workspace header.

To share the workspace with people on your local subnet, double-click `Share Viewer.cmd` and give them the address it prints. Keep the launcher open while people are using it. If the computer has more than one private IPv4 address, run `Share Viewer.cmd <address>` to pick the local adapter. The shared workspace opens without a bundled model. Browser drafts stay in each user's browser, and CAD conversions run on the host computer. If clients cannot reach the link, check whether the network permits inbound TCP port 8081 on the host.

## 3D Viewer

Use **Open model** for `.glb`, `.stp`, or `.step`. STEP files are converted locally with OpenCascade and open automatically when conversion finishes. Use **Save GLB** to keep a converted copy or **Cancel conversion** to stop a pending conversion. The local launcher can also open an optional `model.glb` placed beside it.

- **Display** offers shaded, shaded with feature edges, triangle wireframe, and transparent modes. Choose imported colors, automatic component colors, or monochrome.
- **Section view** clips along one viewer axis at a time. Use the slider, enter a coordinate in millimeters relative to the viewer origin, or click **Pick on axis or model** and choose a point on the highlighted axis guide or model. **Flip cut direction** shows the other side.
- **Zoom** follows the cursor and supports close inspection. **Fit** restores the full model view.
- **Measure** gives the straight-line distance in millimeters between two endpoints. Choose a surface point, a mesh edge or vertex, or a free-space point for each endpoint. Hover in edge or vertex mode to preview the snap target in cyan. Free-space clicks land in a plane parallel to the screen at the orbit target or the first endpoint's depth. To set an exact free-space position, enter X, Y, and Z in millimeters relative to the viewer origin and click **Add point**.
- **Assembly** lets you select from the tree or click the visible model. Use the checkboxes to hide components. The selected component's inspector provides recoloring, isolation, and color reset. Color changes last for the current viewing session.

## 2D Drawing

- The **File**, **Draw**, **Modify**, and **View** menus show each command's shortcut. Use **L** for Line, **R** for Rectangle, **A** for Rectangular array, **Ctrl+Z** for Undo, and **Ctrl+Y** or **Ctrl+Shift+Z** for Redo. **Shift+B** and **Shift+V** switch between the two workspaces.
- Draw lines, rectangles, squares, and circles by picking two points. Start typing or press **P** to enter exact X and Y values next to the pointer. **Enter** advances from X to Y and then places the point. Each rectangle corner can be picked or typed independently. Object snapping picks endpoints, midpoints, and circle centers before the grid.
- Lines default to horizontal or vertical **Ortho** drafting. **F8** toggles it for angled lines. Pick the line's first point, aim with the pointer or an arrow key, type a length in millimeters, then press **Enter** to place the endpoint.
- **Rectangle select (V)** is the default. Click an outline to select one shape, drag left to right to select fully enclosed shapes, or drag right to left to also select shapes the box touches. **Lasso select (F)** follows a freehand drag and selects enclosed or touched shapes. Hold **Shift** while dragging to add to the selection. For **Move**, choose a base point and a destination. **Delete** removes the selection.
- To repeat a selection, press **A** and enter columns, rows, X pitch, and Y pitch in the popup at the pointer. **Enter** advances each step, **Shift+Enter** goes back, and **Esc** cancels. The original occupies the first position.
- For **Chamfer**, set the setback in millimeters, then pick a polygon corner or the shared endpoint of two lines. The setback applies along both adjoining edges.
- For **Fillet (J)**, enter a radius in millimeters and click a corner between two straight edges. The tool trims the adjoining edges and joins them with a tangent arc. DXF and DWG preserve the arc and its radius.
- **Fence trim (X)** removes the span of each straight edge crossed by a two-point fence. The nearest intersections or the edge ends bound the removed span. A crossed edge with no intersections is removed in full. Use **Ctrl+Z** to undo the fence in one step.
- **Measure** adds a dimension between two picked points. Use **Undo** and **Redo** to step through edits.
- Press **T** to add a text note. Enter its content and height in millimeters, then click the drawing or enter X and Y to place it. Select a note and press **Shift+T** to edit it. Notes are included in JSON, DXF, DWG, and PDF exports.
- **Open drawing** accepts JSON, DXF, and DWG. DXF and DWG imports bring editable model-space geometry into the drawing and convert declared units to millimeters. Curves can become approximated paths, and the import reports unsupported entities. The editor uses a single drawing space with simplified geometry and text.
- The browser autosaves the current drawing. **Save drawing** keeps an editable JSON file. Export to DXF, DWG (AutoCAD 2000 format), or a one-page vector PDF fitted to A4. CAD exports write millimeter coordinates and represent measurements as lines and text.

## Setup on another machine

For the portable Windows x64 ZIP, extract the folder and double-click `Open Viewer.cmd`. The ZIP includes the local converters. To run from a source checkout, follow the setup below.

For the smaller Windows x64 setup ZIP, extract the full folder and run `Install Viewer.cmd`. It downloads and verifies the runtimes and converters on first run. After setup, run `Open Viewer.cmd` or `Share Viewer.cmd`. The workspace can run offline after installation.

Install Node.js 22 and run `npm install --omit=dev`. Install 64-bit Python 3.13, then set up the local converters:

```powershell
python -m pip install --target .local-ocp cadquery-ocp-novtk==7.9.3.1.1
python -m pip install --target .local-cad ezdxf==1.4.5 reportlab==4.4.4
```

The DWG helper uses [ACadSharp](https://www.nuget.org/packages/ACadSharp/3.8.35). Install the .NET 10 SDK and build the helper once on the machine running the workspace. `CAD_PYTHON` can point to another Python 3.13 executable.

```powershell
dotnet publish dwg-tool/DwgBridge.csproj -c Release -o .local-dwg-tool
```

After installing the converters, restart `Open Viewer.cmd`. All format conversions run on the local machine. Large STEP assemblies can take several minutes.

To rebuild the smaller setup ZIP after installing the Node dependency and publishing the DWG helper, run `python windows-setup/build.py`.

The prototype displays mesh-based feature edges and open visual sections. The selectable units are the exported assembly components. A component may contain multiple CAD bodies.
