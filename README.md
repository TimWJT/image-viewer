# Image Viewer

A fast image **viewer** for PNG, JPG, WebP, GIF and BMP, with a **dark mode for images**: one key (`D`) turns a bright screenshot, document or white-background diagram into a dark version, without touching the file.

Not an editor, not a library, not a cloud album. Your files never leave the machine and the app makes no network requests.

## Run from source

```bash
npm install
npm start
```

Then open <http://localhost:4175>. That serves the web build, the fastest loop for working on the UI. `?src=samples/diagram.png` loads a sample straight away.

To build the desktop app:

```bash
npm run app:build
```

Installers land in `src-tauri/target/release/bundle/`. `npm run app:dev` runs it with hot reload. `npm run icons` regenerates `src-tauri/icons/` from `assets/icon.svg`.

## What it does

| | |
|---|---|
| **Open** | Open button / `Ctrl`+`O`, drag and drop, paste, double-click in Explorer, "Open with", or the command line. |
| **Folder** | `←` / `→` step through the other images in the same folder, sorted by name the way Explorer sorts (`img2` before `img10`). Wraps at the ends. The neighbours are decoded ahead of time, so stepping is instant. |
| **Zoom** | Wheel or pinch zooms to the cursor, `+` / `−`, `0` fits, `1` is actual size, double-click switches between fit and 100%. 2% to 6400%. Smooth when zoomed out, hard pixels from 300% up. |
| **Pan** | Drag. A small image stays centred; a big one never drifts off past its edges. |
| **Turn** | Rotate (`R`, `Shift`+`R`), flip (`H`, `V`). For viewing only, the file is not changed. |
| **Dark mode** | **Smart invert** flips light and dark but keeps colours (CSS `invert() hue-rotate(180deg)`), so blue links stay blue. **Dimming** turns the brightness down, for photos. A strength slider sets how dark. On/off lasts for the session; mode and strength are remembered. |
| **Save dark copy** | `Ctrl`+`S` writes `name-dark.png` next to the original (then `-dark-2`, …). Never overwrites anything. |
| **Details** | `I` shows dimensions, megapixels, file size, format, date and folder position. |
| **Copy** | `Ctrl`+`C` copies the image as shown (dark if dark mode is on). |
| **Other** | Transparency checkerboard for PNG/WebP/GIF, full screen (`F11`), shortcuts list (`?`), multiple windows (`Ctrl`+`Shift`+`O`). The app follows the system light/dark theme. |

## Keyboard

Press `?` in the app for the full list.

| Key | Action |
|-----|--------|
| `←` `→` / `Home` `End` | Previous / next, first / last image |
| `+` `−` / `0` / `1` | Zoom in / out, fit, actual size |
| `R` / `Shift` `R`, `H` / `V` | Rotate right / left, flip |
| `D` / `Shift` `D` / `[` `]` | Dark mode on/off, switch mode, weaker / stronger |
| `Ctrl` `S` / `Ctrl` `C` | Save dark copy, copy image |
| `I` / `F11` / `?` / `Esc` | Details, full screen, shortcuts, close |

## Security

The page has no filesystem, dialog, shell or updater permission (`src-tauri/capabilities/default.json`, CSP `script-src 'self'`). Rust runs the open dialog and receives drops and "Open with" files itself, and only then grants that image's folder. The app's `asset` scheme serves only images in granted folders, checked before the disk is touched, and the only write is a new `-dark.png` in such a folder.

## Design

Calm, exact, darkroom: graphite neutrals with a faint green-grey tint, one teal accent for active states only, borders instead of shadows (except the two floating panels), 36px controls, verb + thing labels. When image dark mode is on, the stage around the image goes dark too, so an inverted image never sits in a bright frame.

## License

Free for personal and other noncommercial use under the [PolyForm Noncommercial License 1.0.0](LICENSE).
