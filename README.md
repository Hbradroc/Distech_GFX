# Distech GFX Toolkit

Browser tools and a CLI helper for reading, explaining and editing EC-gfxProgram `.gfx` projects without manually unpacking XML.

Similar workflow to [dvf2Json](https://github.com/Hbradroc/dvf2Json): open a file in the browser, work on it, download the result.

## Web app

Live site (after GitHub Pages is enabled): `https://hbradroc.github.io/Distech_GFX/`

The landing page is the **Logic Canvas**. Every page carries a **Tools** dropdown in its header for switching between the five views, and the `.gfx` you open is shared between them — open a file once and each tool offers to pick it up.

| Tool | Page | What it is for |
|------|------|----------------|
| Logic Canvas | `index.html` | Interactive diagram: pan/zoom, drill into custom blocks, trace a signal, insert library blocks, export |
| Parameter Explorer | `explorer.html` | Search and bulk-edit every parameter, then generate a new `.gfx` |
| Logic Diagram Viewer | `wiring.html` | Printable cross-reference of every connection |
| Rung View | `rung-view.html` | Sequential ladder-style listing of one sheet |
| Library Match | `library-view.html` | Which project blocks came from your Library snippets |

### Logic Canvas

- **See the logic.** Sheets render as an interactive SVG diagram. Double-click a custom block to open its internals; the breadcrumb, an **↑ Back** button or `Esc` takes you back out.
- **Understand a block.** Selecting a block explains it in plain terms, with a step-by-step account of how it evaluates, truth tables for the logic and comparator blocks, a worked example, and what happens when an input is Null. Behavioural facts come from the EC-gfxProgram help file and each entry cites its source topic.
- **Trace a signal.** Pick any reference tag and get the end-to-end routes it takes, from a physical input, through the logic, across sheet boundaries via reference hubs and targets, to the output it eventually drives. Duplicate routes are collapsed, and any step can jump the canvas straight to that block.
- **Look at a neighbour without losing your place.** Clicking a connected block's name in the inspector opens it in a small floating window showing that block, its immediate wiring (the first few connections, with a **Show N more** button for the rest) and its explanation — the sheet you were reading stays exactly where it was. Windows can be dragged, chained (click a neighbour inside a window to open that one too), minimised to a bar along the bottom, and restored. Shift-click a name instead to jump the canvas there the old way, or use the window's **Go to it on the sheet** button.
- **Insert with a sanity check.** Before placing a library block you are told how it would fit this project; after placing it you get a connection report covering inputs nothing feeds, outputs nothing reads, tags that would end up with two writers, and whether the new logic reaches a physical output.

### Parameter Explorer

1. Open an EC-gfxProgram `.gfx` **template** file (loads automatically).
2. All parameters are listed on the page — edit any values you need.
3. Click **Generate .gfx** to write your values into the template and download the updated file.
4. Import the generated file in **EC-gfxProgram** and verify before downloading to a controller.

### Run locally

From the project folder:

```bash
npx serve .
```

Then open the local URL shown in the terminal.

## What the tool edits

A `.gfx` file is a ZIP archive. The editor updates known parameter fields in:

| Source | Examples |
|--------|----------|
| `Main.xml` | `BacnetAnalogValueResource` (`DefaultValue`), hardware input scaling, internal constants |
| `Config/Bacnet/ComSensors/CommonConfig.xml` | Com sensor register defaults |

It does **not** rewrite block wiring links themselves (which block connects to which). Use EC-gfxProgram for rewiring logic.

### Parameter sections in the web app

| Section | What it includes |
|---------|------------------|
| Analog / binary setpoints | `supply_low`, `dmp_min`, alarm flags, etc. |
| Hardware inputs & outputs | Input scaling, output min/max/default, PWM period |
| PID tuning | Proportional band, integral/derivative time, dead band |
| Logic module ports | Composite inputs/outputs such as `ventilate.vent_disable` |
| BACnet COV, alarms & metadata | `CovPeriod`, `ObjectName`, `TAG`, `AlarmParameters` |
| Schedules & calendars | Weekly occupancy times and default schedule values |
| Programming sheet constants | `SetpointConstant` / `NumericConstant` blocks (when present) |
| Internal logic constants | Fixed numbers inside logic blocks (`LogicConstant#id`) |
| Com sensor bindings | Register → BACnet point mappings in `*Bindings*.xml` |
| Com sensor registers | Com sensor default register values |

### Single source of truth

`gfx-core.js` is the canonical parser for the web app. For CLI/CSV workflows:

```bash
npm install
node gfx_cli.mjs list project.gfx -o parameters.csv
node gfx_cli.mjs apply project.gfx parameters.csv -o project_modified.gfx
```

`gfx_param_tool.py` delegates to `gfx_cli.mjs` when Node.js is installed; otherwise it uses a limited legacy parser.

### What Distech does not provide

There is **no public SDK** to edit EC-gfxProgram block wiring or `.gfx` project files programmatically. Distech Developer Tools ([developer.distech-controls.com](https://developer.distech-controls.com/)) cover **live controllers** (ECLYPSE REST API, Sky SDK) — not the programming sheet editor. Block wiring remains an EC-gfxProgram task, or a custom XML graph editor built from reverse-engineered `Main.xml` `<Link>` elements.

## CLI (optional)

Python 3.10+ standard library only.

```bash
# Export parameters
python gfx_param_tool.py list project.gfx -o parameters.csv

# Apply CSV edits
python gfx_param_tool.py apply project.gfx parameters.csv -o project_modified.gfx --backup
```

## Files

| File | Description |
|------|-------------|
| `index.html` | Logic Canvas — the landing page |
| `canvas.js` / `canvas.css` | Canvas rendering, explanations, signal tracing, insert checks |
| `gfx-edit.js` | Structural XML editing: insert snippets, move, link, delete, with ID/namespace remapping |
| `block-knowledge.json` | Beginner-facing explanations per block type, grounded in the EC-gfxProgram help file |
| `explorer.html` | Parameter Explorer UI |
| `app.js` | Parameter Explorer logic |
| `gfx-core.js` | Parse / apply GFX parameters in the browser (all sections) |
| `gfx-shared.js` / `gfx-shared.css` | Cross-tool page picker and the shared "currently open file" |
| `param_help.json` | Parameter descriptions for the editor help panel |
| `wiring.html` | Read-only logic wiring viewer (print / PDF) |
| `wiring.js` / `wiring.css` | Wiring viewer UI |
| `styles.css` | Shared styling (matches dvf2Json look) |
| `gfx_param_tool.py` | Command-line helper |
| `test/` | Node test scripts: structural round-trip checks and a synthetic project generator |

## Tests

```bash
npm install
node test/edit-roundtrip.mjs      # structural edits survive serialize / re-parse
node test/make-fixture.mjs        # build a multi-sheet sample project from Library snippets
```

`make-fixture.mjs` assembles a five-sheet `.gfx` from real Library snippets chosen so their reference tags interlock, which gives the canvas something with genuine cross-sheet signal chains to trace. It is a development fixture, not a controller-ready project.

## Deploy to GitHub Pages

1. Push this repository to `https://github.com/Hbradroc/Distech_GFX.git`
2. In GitHub: **Settings → Pages**
3. Source: **Deploy from a branch**
4. Branch: `main` / folder: `/ (root)`
5. Save — the site will be available at `https://hbradroc.github.io/Distech_GFX/`

## Safety notes

- Always keep a backup of the original `.gfx`.
- Open the modified file in EC-gfxProgram before deploying to a live controller.
- When downloading to a device, use the correct EC-gfxProgram sync options (for example **Reinitialize controller specific values and constants**). See the [Distech sync options guide](https://docs.distech-controls.com/bundle/gfx_UG/page/en-US/846312843.html).

## References

- [EC-gfxProgram constants](https://docs.distech-controls.com/bundle/gfx_UG/page/en-US/845626251.html)
- [EC-gfxProgram file menu / import-export](https://docs.distech-controls.com/bundle/gfx_UG/page/en-US/846175243.html)
- [Xpressgfx Points](https://docs-be.distech-controls.com/bundle/xpressgfx-Points_UG/raw/resource/enus/xpressgfx%20Points_UG.pdf) — official Distech Excel add-in for BACnet point lists
