# Weird Mode Design

## Goal

Add two independent invisible modifiers to Tessera that activate on ~15% of tokens each, expanding the visual range without adding new FXHASH feature traits.

- **New Cell Fills** — diagonal and radial gradient directions added to the existing `dir` system
- **Pixel Sorting** — span-based luminance sort applied as a post-process on `pg`

Both modifiers are seeded from `R()` in `setup()` and are fully deterministic per token. Neither appears in `$fx.features()`.

---

## Modifier 1: New Cell Fills

### Config

`config.newFills` (boolean) is burned from `R()` in `setup()` **before** the cell grid construction loop (~line 1330, within the config properties block). It must precede the cell grid because `dir` assignment happens inside that loop.

Activation rate: `R() < 0.15`

### Dir Probability Distribution

When `config.newFills === false` (85% of tokens): existing h/v probabilities unchanged (row-position weighted as currently implemented).

When `config.newFills === true` (15% of tokens): the `dir` assignment in the cell grid loop uses an expanded pool:

| Dir | Weight | Description |
|-----|--------|-------------|
| `"h"` | 40% | Horizontal gradient (existing) |
| `"v"` | 20% | Vertical gradient (existing) |
| `"d1"` | 15% | Diagonal ↘ (top-left → bottom-right) |
| `"d2"` | 15% | Diagonal ↙ (top-right → bottom-left) |
| `"r"` | 10% | Radial from cell center |

The row-position h-bias logic is bypassed when `newFills` is active — all cells draw from the flat distribution above.

### Rendering

New cases added to the cell drawing function (`applyCells()`). d1, d2, and r use the **Canvas 2D gradient API** (`drawingContext.createLinearGradient` / `createRadialGradient`) rather than per-pixel rect() loops.

**Why not per-pixel loops:** The existing h/v cases draw 1D strips (one rect per column or row), scaling with cell width or height. A 2D pixel loop for diagonal/radial fills would call `rect(1,1)` once per pixel — up to 640×432 = 276K calls per cell for a sparse token. At 4K this makes the one-time pg render unacceptably slow. The Canvas 2D gradient API renders the fill in a single `fillRect` call.

**Trade-off:** The drawingContext gradient interpolates in sRGB rather than the chroma color space specified by `cell.mode`. The color transition will differ slightly from h/v cells. This is acceptable for a 15% invisible modifier — the visual character (diagonal/radial direction) dominates over color-space precision.

**Implementation pattern** — wrap each new case in `drawingContext.save()` / `restore()` to prevent the custom `fillStyle` from leaking into p5.js's internal state:

**`"d1"` — diagonal ↘ (top-left → bottom-right)**
```javascript
const grad = graphics.drawingContext.createLinearGradient(
    cell.x, cell.y, cell.x + cell.w, cell.y + cell.h
);
grad.addColorStop(0, fc);
grad.addColorStop(1, nc);
graphics.drawingContext.save();
graphics.drawingContext.fillStyle = grad;
graphics.drawingContext.fillRect(cell.x, cell.y, cell.w, cell.h);
graphics.drawingContext.restore();
```

**`"d2"` — diagonal ↙ (top-right → bottom-left)**
```javascript
const grad = graphics.drawingContext.createLinearGradient(
    cell.x + cell.w, cell.y, cell.x, cell.y + cell.h
);
grad.addColorStop(0, fc);
grad.addColorStop(1, nc);
graphics.drawingContext.save();
graphics.drawingContext.fillStyle = grad;
graphics.drawingContext.fillRect(cell.x, cell.y, cell.w, cell.h);
graphics.drawingContext.restore();
```

**`"r"` — radial from cell center outward**

Radius is set to the cell's corner distance so the gradient reaches full `nc` at the corners:
```javascript
const cx = cell.x + cell.w / 2;
const cy = cell.y + cell.h / 2;
const maxR = Math.sqrt((cell.w / 2) ** 2 + (cell.h / 2) ** 2);
const grad = graphics.drawingContext.createRadialGradient(cx, cy, 0, cx, cy, maxR);
grad.addColorStop(0, fc);
grad.addColorStop(1, nc);
graphics.drawingContext.save();
graphics.drawingContext.fillStyle = grad;
graphics.drawingContext.fillRect(cell.x, cell.y, cell.w, cell.h);
graphics.drawingContext.restore();
```

---

## Modifier 2: Pixel Sorting

### Config

Four values burned from `R()` in `setup()` **after the cell grid loop, before `config.animSeed`**:

```javascript
config.pixelSort          = R() < 0.15;
config.pixelSortDir       = R() < 0.5 ? "h" : "v";
config.pixelSortThreshold = 0.25 + R() * 0.5;   // luminance cutoff: 0.25–0.75
config.pixelSortTarget    = R() < 0.5 ? "bright" : "dark";
```

All four are burned unconditionally so the R() sequence is stable regardless of whether sorting is active.

### Implementation

`applyPixelSort(source, cfg)` — a new function added near the other post-process functions. `source` is the `pg` p5.Graphics buffer. Called at the end of `postProcessing()`, after `applyChromatic()`.

```
applyPixelSort(source, cfg):
  source.loadPixels()
  pixels = source.pixels
  w = source.width, h = source.height

  if cfg.pixelSortDir === "h":
    for each row y in [0, h):
      process_span(pixels, row y, horizontal)
  else:
    for each col x in [0, w):
      process_span(pixels, col x, vertical)

  source.updatePixels()

process_span(pixels, line, direction):
  walk the line pixel by pixel
  luminance = 0.2126*(r/255) + 0.7152*(g/255) + 0.0722*(b/255)
  accumulate contiguous pixels where:
    "bright": luminance > threshold
    "dark":   luminance < threshold
  when span ends (or line ends): sort accumulated span by luminance ascending
    (darkest pixel first — always ascending, no config parameter for sort direction)
    produces a dark→light smear in the scan direction
  write sorted pixels back
```

### Luminance Formula

```javascript
const lum = (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
```

Standard linear luminance (no gamma correction needed — consistent sorting within the already-rendered pixel values).

### Visual Character

Threshold controls how many pixels qualify for sorting (not the darkness of those pixels):

- **Bright target + low threshold (0.25–0.45):** nearly all pixels qualify (`lum > 0.25`) → heavy smear across most of the image
- **Bright target + high threshold (0.55–0.75):** only the brightest pixels qualify → subtle streaks in highlight regions
- **Dark target + low threshold (0.25–0.45):** only the darkest pixels qualify (`lum < 0.25`) → subtle streaks in shadow regions
- **Dark target + high threshold (0.55–0.75):** nearly all pixels qualify (`lum < 0.75`) → heavy smear across most of the image
- **Direction h:** horizontal streaks — complements the mosaic row structure
- **Direction v:** vertical streaks — contrasts the mosaic row structure

---

## Seed Ordering

Both modifiers are deterministic and their R() calls must be placed to not disturb any existing seeds:

1. `config.newFills` — burned **before** the cell grid loop (within config properties block)
2. `config.pixelSort`, `config.pixelSortDir`, `config.pixelSortThreshold`, `config.pixelSortTarget` — burned **after** the cell grid loop, **before** `config.animSeed`

`config.animSeed` remains the last R() call in setup().

> **Note:** This spec assumes a pre-mint collection. Adding `config.newFills` before the cell grid shifts all subsequent R() calls, changing the static render of every existing token. Do not apply these changes to a minted collection.

---

## File Changes

`sketch.js` only. No new files.

| Location | Change |
|----------|--------|
| setup() config block (~line 1330) | Burn `config.newFills` |
| Cell grid dir assignment loop | Branch on `config.newFills` for expanded dir pool |
| `applyCells()` cell draw loop | Add `"d1"`, `"d2"`, `"r"` cases |
| setup() after cell grid, before animSeed | Burn `config.pixelSort`, dir, threshold, target |
| After `applyChromatic()` in `postProcessing()` | Call `applyPixelSort(graphics, cfg)` using the `graphics` parameter already in scope in `postProcessing()` |
| New function before `postProcessing()` | `applyPixelSort(source, cfg)` |
