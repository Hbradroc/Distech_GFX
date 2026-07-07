# Distech GFX Parameter Editor

Web tool and CLI helper for editing EC-gfxProgram `.gfx` project parameters without manually unpacking XML.

Similar workflow to [dvf2Json](https://github.com/Hbradroc/dvf2Json): upload a file in the browser, edit parameters, download the result.

## Web app

Live site (after GitHub Pages is enabled): `https://hbradroc.github.io/Distech_GFX/`

### Use in the browser

1. Open the web app.
2. Upload an EC-gfxProgram `.gfx` **template** file (loads automatically).
3. All parameters are listed on the page — edit any values you need.
4. Click **Generate .gfx** to write your values into the template and download the updated file.
5. Import the generated file in **EC-gfxProgram** and verify before downloading to a controller.

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
| `index.html` | Web UI |
| `app.js` | Browser UI logic |
| `gfx-core.js` | Parse / apply GFX parameters in the browser (all sections) |
| `param_help.json` | Parameter descriptions for the editor help panel |
| `wiring.html` | Read-only logic wiring viewer (print / PDF) |
| `wiring.js` / `wiring.css` | Wiring viewer UI |
| `styles.css` | Shared styling (matches dvf2Json look) |
| `gfx_param_tool.py` | Command-line helper |

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
