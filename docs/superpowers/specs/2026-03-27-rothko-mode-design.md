# Rothko Mode — Rare Composition Feature

**Date:** 2026-03-27
**Project:** 260325-2 (FXHASH generative art, p5.js)
**Status:** Approved for implementation

---

## Overview

Add a rare "Rothko Mode" composition to the piece. Approximately 4% of tokens will render as stacked horizontal color fields inspired by Mark Rothko's paintings — large, hue-distinct rectangles with soft painterly edges and a contrasting background visible in the margins and gaps. The effect reuses existing rendering functions (`applyCells`, `applySmear`, post-processing stack) within a new compositional layout, so Rothko tokens share the same gradient-cell texture quality as normal tokens while being immediately visually distinct at thumbnail size.

---

## Trigger & Rarity

- **Probability:** `config.isRothko = R() < 0.04` (~4%, drawn in `setup` after palette load)
- **Rarity rationale:** ~40 per 1000 mints — rare enough to feel like a genuine pull, common enough to surface in the wild and drive secondary desire
- **New feature trait** (present on ALL tokens):
  - `Composition: "Fields"` — Rothko tokens
  - `Composition: "Mosaic"` — all other tokens (96%)

---

## Config Values (Rothko-specific)

Drawn from `R()` in sequence immediately after `config.isRothko` is set:

| Key | Range | Purpose |
|-----|-------|---------|
| `config.fieldCount` | 2–3 | Number of horizontal color fields |
| `config.fieldGap` | 1–3% of canvas height | Gap between fields (background shows through) |
| `config.fieldMargin` | 2–4% of canvas width | Margin on all four sides (top, bottom, left, right) — background shows around all fields |

These are only set when `config.isRothko` is true. Normal tokens do not consume these R() calls.

**RNG note:** Rothko tokens consume a substantially different number of R() calls than normal tokens due to the per-field `applyCells` calls (each shuffle within `applyCells` consumes ~18–20 R() calls via `sort(() => R() - 0.5)`). The two branches are intentionally non-comparable. This is acceptable since the piece is unpublished and both branches are internally deterministic.

---

## `initRothkoScene(graphics, config, pallet)`

Replaces `initScene` when `config.isRothko` is true. Called from `draw()`:

```javascript
config.isRothko
    ? initRothkoScene(pg, config, pallet)
    : initScene(pg, config, pallet, cells);
```

**Explicitly excluded from `initRothkoScene`:** `applySquareWave`, `captureCells`, `drawPixelation`. These are normal-mode-only effects.

### Step 1 — Background fill
`graphics.background(config.bgColor)` — darkest palette color fills everything, including all margins and gaps between fields.

### Step 2 — Zone layout
Compute the usable canvas area by subtracting `config.fieldMargin` from all four sides. Divide this area into `config.fieldCount` zones separated by `config.fieldGap` strips. Each zone gets:
- `x`: `config.fieldMargin`
- `width`: `config.width - config.fieldMargin * 2`
- `y`: computed start after margin + prior zones + gaps
- `height`: weighted-random share of usable height (`0.6 + R() * 0.8` weights, same normalization as normal row heights)

### Step 3 — Palette clustering by hue
Group palette colors into `config.fieldCount` hue clusters using LCH hue values (chroma.js). Sort colors by LCH hue, then divide into equal-sized clusters.

**Low hue variance fallback:** If total hue spread across the palette is less than 60°, fall back to luminance-based clustering instead — divide the palette (already sorted darkest→lightest) into `fieldCount` equal segments. This ensures fields remain visually distinct even on near-neutral palettes.

Each field gets a sub-palette of 2–3 colors from its cluster.

### Step 4 — Per-field cell rendering
For each field zone:
1. Build a mini cell grid **constrained to the field's bounds** — cells are clipped to `[zone.x, zone.y, zone.width, zone.height]`. Cell count: `randomInt(R, 6, 16)` columns, `randomInt(R, 3, 7)` rows.
2. Call `applyCells(graphics, fieldSubPalette, fieldCells)` with the field's sub-palette.
3. Call a **zone-bounded smear** at the field's top and bottom edges: 2–4 passes with x drawn from `[zone.x, zone.x + zone.width]`, y constrained to within ~10% of the field's top or bottom edge. Use `d=2` (east) or `d=4` (west) only — no north/south smears in Rothko mode. This requires passing zone bounds to constrain smear coordinates — see implementation note below.

**Implementation note for smear:** The existing `applySmear` uses `config.width` and `config.height` to draw smear coordinates across the full canvas. For Rothko mode, smear must be scoped to the field zone. Either: (a) call `drawSmear` directly with coordinates computed within the zone, or (b) add a `bounds` parameter to `applySmear`. Option (a) is simpler.

### Step 5 — Shared post-processing (called once on full buffer after all fields)
In this order:
- `applyAtmosphere(graphics, pallet, config.hazeStrength)` — called once on the full buffer, affecting only the top ~45% of the canvas (its existing hardcoded behavior). This washes the topmost field and leaves lower fields untouched, which is the correct aesthetic.
- `applyLightLeaks(graphics, pallet, config.lightLeakCount, createRng(config.lightLeakSeed))`
- `applyPostProcess(graphics, config.bgColor, config.vigStrength, config.grainAmt, config.grainSeed)`
- `applyChromatic(graphics, config.chromaShift)`

---

## `draw()` Change

```javascript
function draw() {
    if (!pallet) return;
    background(config.bgColor || "#111");

    config.isRothko
        ? initRothkoScene(pg, config, pallet)
        : initScene(pg, config, pallet, cells);

    image(pg, 0, 0, width, height);
    $fx.preview();
    noLoop();
}
```

---

## `setup()` Change

After all existing config values are set, add:

```javascript
config.isRothko = R() < 0.04;
if (config.isRothko) {
    config.fieldCount = randomInt(R, 2, 3);
    config.fieldGap = Math.round(config.height * (0.01 + R() * 0.02));
    config.fieldMargin = Math.round(config.width * (0.02 + R() * 0.02));
}
```

Feature object gains (for all tokens):
```javascript
Composition: config.isRothko ? "Fields" : "Mosaic",
```

---

## What Is NOT Changed

- `initScene` — untouched
- `applyCells`, `applySmear` / `drawSmear`, `applyAtmosphere`, `applyLightLeaks`, `applyPostProcess`, `applyChromatic` — untouched signatures; Rothko mode calls them directly with appropriate arguments
- Normal token rendering path — visually identical to current
- Normal token R() stream — shifts by exactly 1 call (the `config.isRothko` draw); the 3 Rothko config values are only consumed when `isRothko` is true

---

## Success Criteria

- Rothko tokens are immediately visually distinct at thumbnail size
- Each field has a visually distinct dominant color (hue-clustered, or luminance-segmented as fallback)
- Background color is visible in margins on all four sides and in gaps between fields
- Field interiors have the same gradient-cell texture quality as normal tokens
- Field boundaries are soft/painterly (smear at edges), not hard geometric lines
- All post-processing effects (grain, atmosphere, chromatic, light leaks) apply to the full buffer as in normal mode
- Deterministic: same hash always produces the same output
- Normal tokens are visually unchanged (modulo 1 R() call shift, acceptable pre-publication)
