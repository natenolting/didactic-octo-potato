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

New cases added to the cell drawing function (`applyCells()`) alongside the existing `"h"` and `"v"` pixel loops. All use the same `chroma.mix(fc, nc, inter, cell.mode)` interpolation — only the `inter` parameter changes.

In all formulas below, `x` and `y` are **cell-local pixel offsets** (0 to `cell.w - 1` and 0 to `cell.h - 1` respectively), and `w` and `h` are `cell.w` and `cell.h`. This matches the coordinate system used by the existing `"h"` and `"v"` loops.

**`"d1"` — diagonal ↘**
```javascript
inter = (x / w + y / h) / 2;
```

**`"d2"` — diagonal ↙**
```javascript
inter = ((w - x) / w + y / h) / 2;
```

**`"r"` — radial from center**
```javascript
const dx = x / w - 0.5;
const dy = y / h - 0.5;
inter = Math.min(1, Math.sqrt(dx * dx + dy * dy) * Math.SQRT2);
```

For d1/d2, `inter` is in the open interval (0, ~1) — it reaches 0 at the leading corner of d1 (x=0, y=0) and approaches but never quite reaches 1 at the trailing corner. This slight compression at the extremes is intentional: the first and last palette colors appear at near-full intensity but with a subtle gradient falloff at the cell edge. Radial is explicitly clamped via `Math.min(1, ...)` to handle corner pixels.

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
