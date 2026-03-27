# Rothko Mode Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a ~4% rare "Rothko Mode" that renders stacked horizontal color fields with soft painterly edges, reusing existing cell/smear/post-processing functions within a new compositional layout.

**Architecture:** `config.isRothko` is drawn in `setup()` after palette load; when true, `draw()` calls `initRothkoScene()` instead of `initScene()`. `initRothkoScene` builds per-field cell grids within computed zone bounds, calls `applyCells` and `drawSmear` directly (zone-constrained), then runs the shared post-processing stack unchanged.

**Tech Stack:** p5.js v2.2.3, chroma.js, vanilla JS — all in `sketch.js`. No test framework; verification is visual via browser + Playwright screenshots.

---

## File Structure

| File | Change |
|------|--------|
| `sketch.js` | Add `clusterByHue()`, `buildRothkoZones()`, `initRothkoScene()`; modify `setup()` and `draw()` |

No new files. All additions follow the existing single-file pattern.

---

### Task 1: Add Rothko config values and `Composition` feature trait to `setup()`

**Files:**
- Modify: `sketch.js` — setup function, after `config.lightLeakSeed` line

- [ ] **Step 1: Add Rothko config block in `setup()`**

After `config.lightLeakSeed = Math.round(R() * 0xffffffff);`, add:

```javascript
config.isRothko = R() < 0.04;
if (config.isRothko) {
    config.fieldCount = randomInt(R, 2, 3);
    config.fieldGap = Math.round(config.height * (0.01 + R() * 0.02));
    config.fieldMargin = Math.round(config.width * (0.02 + R() * 0.02));
}
```

- [ ] **Step 2: Add `Composition` feature to `$fx.features({})`**

In the `$fx.features({...})` call, add a new key:
```javascript
Composition: config.isRothko ? "Fields" : "Mosaic",
```

- [ ] **Step 3: Force Rothko on for development**

Immediately after the `if (config.isRothko)` block, add this temporary dev override so you can develop and verify without hunting for a seed that triggers 4%:
```javascript
// DEV ONLY — remove before final commit
config.isRothko = true;
config.fieldCount = config.fieldCount || randomInt(R, 2, 3);
config.fieldGap = config.fieldGap || Math.round(config.height * 0.015);
config.fieldMargin = config.fieldMargin || Math.round(config.width * 0.03);
```

- [ ] **Step 4: Verify in browser**

Open `http://localhost:3000/?seed=42`. Console should show `Composition: "Fields"` in the features log. Render is visually unchanged (Rothko path not wired yet). No JS errors.

- [ ] **Step 5: Commit**

```bash
git add sketch.js
git commit -m "feat: add Rothko config and Composition feature trait"
```

---

### Task 2: Add `clusterByHue(pal, count)` utility

**Files:**
- Modify: `sketch.js` — add before `canvasSize()`

Groups palette colors into hue-distinct sub-palettes. Falls back to luminance segmentation if hue spread is too narrow.

- [ ] **Step 1: Write `clusterByHue`**

```javascript
/**
 * Groups palette colors into `count` hue clusters using LCH hue values.
 * Falls back to luminance-based segmentation if total hue spread < 60°
 * (handles near-neutral/greyscale palettes).
 * @param {string[]} pal - Palette hex strings (any order accepted).
 * @param {number} count - Number of clusters to produce.
 * @returns {string[][]} Array of `count` sub-palettes.
 */
function clusterByHue(pal, count) {
    const withHue = pal.map((c) => ({ c, h: chroma(c).lch()[2] || 0 }));
    const hues = withHue.map((x) => x.h);
    const spread = Math.max(...hues) - Math.min(...hues);

    // Low hue variance → fall back to luminance order (palette already sorted dark→light)
    const sorted =
        spread < 60
            ? [...pal]
            : withHue.sort((a, b) => a.h - b.h).map((x) => x.c);

    // Divide evenly into count groups
    const size = Math.ceil(sorted.length / count);
    const clusters = Array.from({ length: count }, (_, i) =>
        sorted.slice(i * size, (i + 1) * size),
    );
    // Guard: ensure no empty cluster (edge case with very small palettes)
    return clusters.map((cl, i) =>
        cl.length > 0 ? cl : [sorted[i % sorted.length]],
    );
}
```

- [ ] **Step 2: Verify no errors in browser**

Open `http://localhost:3000/?seed=42`. No JS errors in console.

- [ ] **Step 3: Commit**

```bash
git add sketch.js
git commit -m "feat: add clusterByHue palette utility for Rothko mode"
```

---

### Task 3: Add `buildRothkoZones(cfg)` utility

**Files:**
- Modify: `sketch.js` — add after `clusterByHue`

Computes the bounding rectangle for each field zone from config values.

- [ ] **Step 1: Write `buildRothkoZones`**

```javascript
/**
 * Computes the bounding rectangle for each Rothko field zone.
 * Subtracts fieldMargin from all four sides, then divides the remaining
 * height into fieldCount zones separated by fieldGap strips.
 * Zone heights use weighted-random normalization (same pattern as normal row heights).
 * @param {object} cfg - config with width, height, fieldCount, fieldGap, fieldMargin.
 * @returns {Array<{x:number, y:number, width:number, height:number}>}
 */
function buildRothkoZones(cfg) {
    const usableW = cfg.width - cfg.fieldMargin * 2;
    const totalGap = cfg.fieldGap * (cfg.fieldCount - 1);
    const usableH = cfg.height - cfg.fieldMargin * 2 - totalGap;

    // Weighted random heights, normalized to fill usableH exactly
    const rawH = Array.from({ length: cfg.fieldCount }, () => 0.6 + R() * 0.8);
    const totalRaw = rawH.reduce((a, b) => a + b, 0);
    const heights = rawH.map((h) =>
        Math.max(10, Math.round((h / totalRaw) * usableH)),
    );
    // Fix rounding drift on last zone
    const drift = usableH - heights.reduce((a, b) => a + b, 0);
    heights[heights.length - 1] = Math.max(
        10,
        heights[heights.length - 1] + drift,
    );

    const zones = [];
    let yPos = cfg.fieldMargin;
    for (let i = 0; i < cfg.fieldCount; i++) {
        zones.push({ x: cfg.fieldMargin, y: yPos, width: usableW, height: heights[i] });
        yPos += heights[i] + cfg.fieldGap;
    }
    return zones;
}
```

- [ ] **Step 2: Verify no errors in browser**

Open `http://localhost:3000/?seed=42`. No JS errors in console.

- [ ] **Step 3: Commit**

```bash
git add sketch.js
git commit -m "feat: add buildRothkoZones geometry utility"
```

---

### Task 4: Implement `initRothkoScene(graphics, cfg, pal)`

**Files:**
- Modify: `sketch.js` — add before `draw()`

The main Rothko render function. Builds cell grids per zone, applies smear at zone edges, then runs the shared post-processing stack.

- [ ] **Step 1: Write `initRothkoScene`**

```javascript
/**
 * Renders the Rothko Mode composition — stacked horizontal color fields
 * with soft painterly edges. Called instead of initScene when config.isRothko
 * is true. Reuses applyCells, drawSmear, and the full post-processing stack.
 * @param {p5.Graphics} graphics
 * @param {object} cfg - config object
 * @param {string[]} pal - Palette sorted darkest→lightest
 */
function initRothkoScene(graphics, cfg, pal) {
    graphics.background(cfg.bgColor || "#111");
    graphics.noStroke();

    const zones = buildRothkoZones(cfg);
    const clusters = clusterByHue(pal, zones.length);
    const MODES = ["lab", "lch", "hsl"];

    for (let zi = 0; zi < zones.length; zi++) {
        const zone = zones[zi];
        const fieldPal = clusters[zi];

        // Build mini cell grid constrained to zone bounds
        const cols = randomInt(R, 6, 16);
        const rows = randomInt(R, 3, 7);
        const cellW = zone.width / cols;

        const rawH = Array.from({ length: rows }, () => 0.6 + R() * 0.8);
        const totalRaw = rawH.reduce((a, b) => a + b, 0);
        const rowHeights = rawH.map((h) =>
            Math.max(2, Math.round((h / totalRaw) * zone.height)),
        );
        const hDrift = zone.height - rowHeights.reduce((a, b) => a + b, 0);
        rowHeights[rowHeights.length - 1] = Math.max(
            2,
            rowHeights[rowHeights.length - 1] + hDrift,
        );

        const fieldCells = [];
        let yPos = zone.y;
        for (let row = 0; row < rows; row++) {
            const cellH = rowHeights[row];
            const offset = row % 2 === 1 ? cellW * 0.5 : 0;
            const numCols = row % 2 === 1 ? cols + 1 : cols;
            const dir = R() < 0.5 ? "h" : "v";
            const mode = MODES[randomInt(R, 0, MODES.length - 1)];
            for (let col = 0; col < numCols; col++) {
                fieldCells.push({
                    x: zone.x + col * cellW - offset,
                    y: yPos,
                    w: cellW,
                    h: cellH,
                    dir,
                    mode,
                });
            }
            yPos += rowHeights[row];
        }

        applyCells(graphics, fieldPal, fieldCells);

        // Zone-constrained smear at field top and bottom edges
        // Use d=2 (east) or d=4 (west) only — no north/south in Rothko mode
        const smearCount = randomInt(R, 2, 4);
        for (let s = 0; s < smearCount; s++) {
            const sx = zone.x + R() * zone.width;
            const sw = zone.width * (0.1 + R() * 0.3);
            const sh = Math.max(4, zone.height * (0.05 + R() * 0.1));
            const d = R() < 0.5 ? 2 : 4;
            // Top edge
            drawSmear(graphics, sx, zone.y + R() * zone.height * 0.1, sw, sh, d);
            // Bottom edge
            drawSmear(graphics, sx, zone.y + zone.height * (0.9 + R() * 0.1), sw, sh, d);
        }
    }

    // Shared post-processing — called once on full buffer after all fields
    applyAtmosphere(graphics, pal, cfg.hazeStrength);
    applyLightLeaks(graphics, pal, cfg.lightLeakCount, createRng(cfg.lightLeakSeed));
    applyPostProcess(graphics, cfg.bgColor || "#111", cfg.vigStrength, cfg.grainAmt, cfg.grainSeed);
    applyChromatic(graphics, cfg.chromaShift);
}
```

- [ ] **Step 2: Verify no errors in browser (render still unchanged)**

Open `http://localhost:3000/?seed=42`. Console should have no JS errors. Render still shows normal mode (draw() not branched yet).

- [ ] **Step 3: Commit**

```bash
git add sketch.js
git commit -m "feat: add initRothkoScene function"
```

---

### Task 5: Wire `draw()` to branch on `config.isRothko`

**Files:**
- Modify: `sketch.js` — draw function

- [ ] **Step 1: Update `draw()`**

Replace:
```javascript
initScene(pg, config, pallet, cells);
```
With:
```javascript
config.isRothko
    ? initRothkoScene(pg, config, pallet)
    : initScene(pg, config, pallet, cells);
```

- [ ] **Step 2: Verify Rothko render in browser**

Open `http://localhost:3000/?seed=42` (dev override still active). You should see:
- 2–3 stacked horizontal field bands
- Gradient-cell texture inside each band
- Background color visible in margins on all four sides and in the gap(s) between fields
- Soft smeared edges at field boundaries (not sharp geometric lines)
- Post-processing effects visible (grain, atmospheric haze at top, chromatic fringing)

- [ ] **Step 3: Check console**

Console should show `Composition: "Fields"`. No JS errors.

- [ ] **Step 4: Test multiple seeds with dev override**

Try `?seed=7`, `?seed=200`, `?seed=999`. Each should render as Rothko (override is active). Verify the composition varies (different field counts, different color distributions, different band proportions).

- [ ] **Step 5: Commit**

```bash
git add sketch.js
git commit -m "feat: wire draw() to branch between initRothkoScene and initScene"
```

---

### Task 6: Remove dev override and verify final behavior

**Files:**
- Modify: `sketch.js` — remove the temporary `config.isRothko = true` block

- [ ] **Step 1: Remove the forced override**

Remove the entire "DEV ONLY" block added in Task 1 Step 3:
```javascript
// DEV ONLY — remove before final commit
config.isRothko = true;
config.fieldCount = config.fieldCount || randomInt(R, 2, 3);
config.fieldGap = config.fieldGap || Math.round(config.height * 0.015);
config.fieldMargin = config.fieldMargin || Math.round(config.width * 0.03);
```

- [ ] **Step 2: Find Rothko seeds**

Scan seeds in the browser until you find ones that produce `Composition: "Fields"` in the console. With a 4% rate, expect to find one within the first ~25 seeds. Try: `?seed=3`, `?seed=5`, `?seed=11`, `?seed=17`, `?seed=23` etc.

- [ ] **Step 3: Screenshot Rothko renders**

Take Playwright screenshots of at least 3 Rothko seeds. For each, verify:
- 2–3 distinct horizontal bands visible
- Each band has a visually distinct color family
- Background color visible in margins (all four sides) and between bands
- Band interiors show gradient-cell texture
- Band edges are soft/painterly, not hard geometric lines

- [ ] **Step 4: Verify determinism**

Load one Rothko seed twice in separate page loads. Confirm renders are pixel-identical.

- [ ] **Step 5: Verify normal tokens unchanged**

Try 5 non-Rothko seeds. Console should show `Composition: "Mosaic"`. Renders should be visually identical to pre-implementation behavior.

- [ ] **Step 6: Final commit**

```bash
git add sketch.js
git commit -m "feat: Rothko Mode complete — rare stacked field composition (~4% of tokens)"
```
