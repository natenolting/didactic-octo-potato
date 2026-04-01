# Weird Mode Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add two independent invisible modifiers — new diagonal/radial cell fill types and span-based pixel sorting — that each activate on ~15% of tokens.

**Architecture:** `config.newFills` is burned before the cell grid so dir assignment can use the expanded pool; `applyCells()` gains d1/d2/r cases using `drawingContext` gradient API for performance (per-pixel 2D loops at 4K would be ~83K rect() calls per cell). `config.pixelSort` and its three parameters are burned after the cell grid, before `config.animSeed`; `applyPixelSort()` is a new function called at the end of `postProcessing()`.

**Tech Stack:** p5.js v2, chroma.js, vanilla JS — all changes in `sketch.js` only. No test framework; verification is visual via browser at `http://localhost:5502`.

**Spec:** `docs/superpowers/specs/2026-03-31-weird-mode-design.md`

---

## File Structure

| File | Change |
|------|--------|
| `sketch.js` | All changes — burn config values, expand dir assignment, add rendering cases, add applyPixelSort(), call from postProcessing() |

---

### Task 1: Burn `config.newFills` in setup()

**Files:**
- Modify: `sketch.js` — insert one line before the `// Build cell grid` comment (~line 1365)

The cell grid loop assigns `dir` per cell (line 1387). `config.newFills` must be set **before** that loop. The natural place is the end of the config properties block, just before the `// Build cell grid — layout only, no palette colors needed.` comment.

- [ ] **Step 1: Find the exact anchor line**

Open `sketch.js` and locate the comment `// Build cell grid — layout only, no palette colors needed.` Note its line number.

- [ ] **Step 2: Insert `config.newFills` immediately before that comment**

```javascript
config.newFills = R() < 0.15;

// Build cell grid — layout only, no palette colors needed.
```

- [ ] **Step 3: Verify in browser — mosaic seed**

Open `http://localhost:5502/?fxhash=ooEmXhUTtSDuQGBZMRBQsbXR9rZApFr1pCjQnrevLLoo3yhKWxc`. No JS errors. Render is visually different from before (seed sequence has shifted — expected for pre-mint). Confirms `config.newFills` is being set without crashing.

- [ ] **Step 4: Commit**

```bash
git add sketch.js
git commit -m "feat: burn config.newFills before cell grid"
```

---

### Task 2: Expand dir assignment in cell grid loop

**Files:**
- Modify: `sketch.js:1387` — replace the single `const dir = R() < hProb ? "h" : "v";` line

Current line 1387 (line number may have shifted by 1 after Task 1 — find it by searching for `const dir = R() < hProb`):

```javascript
const dir = R() < hProb ? "h" : "v";
```

Replace with:

```javascript
let dir;
if (config.newFills) {
	// Expanded pool: h 40%, v 20%, d1 15%, d2 15%, r 10%.
	// Row-position h-bias is bypassed when newFills is active.
	const d = R();
	dir = d < 0.40 ? "h" : d < 0.60 ? "v" : d < 0.75 ? "d1" : d < 0.90 ? "d2" : "r";
} else {
	dir = R() < hProb ? "h" : "v";
}
```

- [ ] **Step 1: Apply the replacement**

Find `const dir = R() < hProb ? "h" : "v";` (inside the cell grid for loop) and replace with the block above.

- [ ] **Step 2: Verify in browser**

Open `http://localhost:5502/?fxhash=ooEmXhUTtSDuQGBZMRBQsbXR9rZApFr1pCjQnrevLLoo3yhKWxc`. No JS errors. For a `newFills=true` token the render may look broken (unknown dir values not yet drawn) — that is expected. For a `newFills=false` token the render looks normal.

To force a `newFills=true` token for testing, temporarily change `R() < 0.15` to `R() < 1.0` (always active), reload, confirm the page renders (even if wrong), then revert.

- [ ] **Step 3: Commit**

```bash
git add sketch.js
git commit -m "feat: expand cell dir pool when config.newFills is active"
```

---

### Task 3: Add d1/d2/r rendering to `applyCells()`

**Files:**
- Modify: `sketch.js` — inside `applyCells()`, expand the `if (cell.dir === "v") { ... } else { ... }` block (~lines 1837–1849)

**Implementation note:** d1/d2/r use `drawingContext` (native Canvas 2D gradient API) instead of the per-pixel rect() loop used by h/v. A pixel loop over a 4K cell would require ~83K individual rect() calls per cell; `fillRect` with a gradient is one call. Color interpolation uses sRGB (not chroma.mix color-space blending) — visually slightly different from h/v cells but fast and acceptable.

Current block to replace:

```javascript
if (cell.dir === "v") {
    for (let g = 0; g < cell.h; g++) {
        let inter = g / cell.h;
        graphics.fill(chroma.mix(fc, nc, inter, cell.mode).hex());
        graphics.rect(cell.x, cell.y + g, cell.w, 1);
    }
} else {
    for (let g = 0; g < cell.w; g++) {
        let inter = g / cell.w;
        graphics.fill(chroma.mix(fc, nc, inter, cell.mode).hex());
        graphics.rect(cell.x + g, cell.y, 1, cell.h);
    }
}
```

Replace with:

```javascript
if (cell.dir === "v") {
	for (let g = 0; g < cell.h; g++) {
		let inter = g / cell.h;
		graphics.fill(chroma.mix(fc, nc, inter, cell.mode).hex());
		graphics.rect(cell.x, cell.y + g, cell.w, 1);
	}
} else if (cell.dir === "d1") {
	// Diagonal ↘ — gradient from top-left to bottom-right.
	// Uses drawingContext for performance (sRGB interpolation).
	const grad = graphics.drawingContext.createLinearGradient(
		cell.x, cell.y,
		cell.x + cell.w, cell.y + cell.h
	);
	grad.addColorStop(0, fc);
	grad.addColorStop(1, nc);
	graphics.drawingContext.save();
	graphics.drawingContext.fillStyle = grad;
	graphics.drawingContext.fillRect(cell.x, cell.y, cell.w, cell.h);
	graphics.drawingContext.restore();
} else if (cell.dir === "d2") {
	// Diagonal ↙ — gradient from top-right to bottom-left.
	const grad = graphics.drawingContext.createLinearGradient(
		cell.x + cell.w, cell.y,
		cell.x, cell.y + cell.h
	);
	grad.addColorStop(0, fc);
	grad.addColorStop(1, nc);
	graphics.drawingContext.save();
	graphics.drawingContext.fillStyle = grad;
	graphics.drawingContext.fillRect(cell.x, cell.y, cell.w, cell.h);
	graphics.drawingContext.restore();
} else if (cell.dir === "r") {
	// Radial — gradient from cell center outward to corners.
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
} else {
	// "h" — horizontal, and fallback for any unknown dir.
	for (let g = 0; g < cell.w; g++) {
		let inter = g / cell.w;
		graphics.fill(chroma.mix(fc, nc, inter, cell.mode).hex());
		graphics.rect(cell.x + g, cell.y, 1, cell.h);
	}
}
```

- [ ] **Step 1: Apply the replacement in `applyCells()`**

Find the `if (cell.dir === "v") {` block inside `applyCells()` and replace the full if/else with the block above.

- [ ] **Step 2: Force `config.newFills = true` temporarily and verify in browser**

Temporarily change `config.newFills = R() < 0.15` to `config.newFills = true`. Open `http://localhost:5502/?fxhash=ooEmXhUTtSDuQGBZMRBQsbXR9rZApFr1pCjQnrevLLoo3yhKWxc`. Check:
- No JS errors in console
- Render shows diagonal and/or radial gradient cells mixed in
- The canvas fills completely (no blank cells)
- Gradient cells blend with h/v cells visually

- [ ] **Step 3: Revert the forced `config.newFills = true` back to `R() < 0.15`**

- [ ] **Step 4: Verify `newFills=false` tokens are unchanged**

Reload the same URL. Confirm the render looks normal (no new fill types visible at standard 15% rate — most tokens won't show them). Try a few seeds to find a `newFills=true` token; when found, confirm it renders without errors.

- [ ] **Step 5: Commit**

```bash
git add sketch.js
git commit -m "feat: add d1/d2/r gradient fill cases to applyCells()"
```

---

### Task 4: Burn pixelSort config values in setup()

**Files:**
- Modify: `sketch.js` — insert four lines after the cell grid for loop, before `config.animSeed`

The cell grid for loop ends at the `}` after `yPos += rowHeights[y];` (~line 1412). The `// Animation seed` comment follows immediately. Insert between them:

```javascript
// Pixel sort modifier — burned after cell grid, before animSeed.
// All four values burned unconditionally so R() sequence is stable.
config.pixelSort          = R() < 0.15;
config.pixelSortDir       = R() < 0.5 ? "h" : "v";
config.pixelSortThreshold = 0.25 + R() * 0.5;
config.pixelSortTarget    = R() < 0.5 ? "bright" : "dark";

// Animation seed — burned last so it does not shift any prior R() calls.
```

- [ ] **Step 1: Find the anchor — locate `// Animation seed — burned last` comment**

The comment is immediately after the cell grid closing `}`. Insert the pixelSort block before it.

- [ ] **Step 2: Insert the four config lines**

After `yPos += rowHeights[y]; }` (end of cell grid) and before `// Animation seed`:

```javascript
	// Pixel sort modifier — burned after cell grid, before animSeed.
	// All four values burned unconditionally so R() sequence is stable.
	config.pixelSort          = R() < 0.15;
	config.pixelSortDir       = R() < 0.5 ? "h" : "v";
	config.pixelSortThreshold = 0.25 + R() * 0.5;
	config.pixelSortTarget    = R() < 0.5 ? "bright" : "dark";
```

- [ ] **Step 3: Verify in browser**

Open `http://localhost:5502/?fxhash=ooEmXhUTtSDuQGBZMRBQsbXR9rZApFr1pCjQnrevLLoo3yhKWxc`. No JS errors. Render is visually unchanged (pixel sort not called yet).

- [ ] **Step 4: Commit**

```bash
git add sketch.js
git commit -m "feat: burn pixelSort config values in setup()"
```

---

### Task 5: Add `applyPixelSort()` function

**Files:**
- Modify: `sketch.js` — add new function immediately before `postProcessing()` (~line 2138)

`applyPixelSort` operates on the `pg` p5.Graphics buffer's pixel array. It uses the same `source.loadPixels()` / `source.pixels` / `source.updatePixels()` pattern as the existing `applyChromatic()` and `applyVignette()` functions.

- [ ] **Step 1: Add `applyPixelSort()` before `postProcessing()`**

Insert immediately before `function postProcessing(graphics, cfg, pal) {`:

```javascript
/**
 * Span-based pixel sort post-process. Sorts contiguous runs of qualifying
 * pixels (above or below a luminance threshold) by luminance ascending,
 * creating streaks in the horizontal or vertical scan direction.
 * Only runs when cfg.pixelSort is true.
 *
 * @param {p5.Graphics} source - The pg buffer to sort in-place.
 * @param {object} cfg - config object with pixelSort, pixelSortDir,
 *                       pixelSortThreshold, and pixelSortTarget.
 */
function applyPixelSort(source, cfg) {
	if (!cfg.pixelSort) return;
	source.loadPixels();
	const pix = source.pixels;
	const w = source.width;
	const h = source.height;
	const threshold = cfg.pixelSortThreshold;
	const bright = cfg.pixelSortTarget === "bright";

	// Returns true if the pixel at pix[idx] qualifies for sorting.
	function inSpan(idx) {
		const lum = (0.2126 * pix[idx] + 0.7152 * pix[idx + 1] + 0.0722 * pix[idx + 2]) / 255;
		return bright ? lum > threshold : lum < threshold;
	}

	// Sorts a collected span of pixel indices by luminance ascending (darkest first).
	// Writes sorted values back to the original positions in the span.
	function sortSpan(span) {
		if (span.length < 2) return;
		const data = span.map(idx => ({
			r: pix[idx], g: pix[idx + 1], b: pix[idx + 2], a: pix[idx + 3],
			lum: (0.2126 * pix[idx] + 0.7152 * pix[idx + 1] + 0.0722 * pix[idx + 2]) / 255,
		}));
		data.sort((a, b) => a.lum - b.lum);
		span.forEach((origIdx, i) => {
			pix[origIdx]     = data[i].r;
			pix[origIdx + 1] = data[i].g;
			pix[origIdx + 2] = data[i].b;
			pix[origIdx + 3] = data[i].a;
		});
	}

	if (cfg.pixelSortDir === "h") {
		for (let y = 0; y < h; y++) {
			let span = [];
			for (let x = 0; x < w; x++) {
				const idx = (y * w + x) * 4;
				if (inSpan(idx)) {
					span.push(idx);
				} else {
					sortSpan(span);
					span = [];
				}
			}
			sortSpan(span); // flush span at end of row
		}
	} else {
		for (let x = 0; x < w; x++) {
			let span = [];
			for (let y = 0; y < h; y++) {
				const idx = (y * w + x) * 4;
				if (inSpan(idx)) {
					span.push(idx);
				} else {
					sortSpan(span);
					span = [];
				}
			}
			sortSpan(span); // flush span at end of column
		}
	}

	source.updatePixels();
}
```

- [ ] **Step 2: Verify the function is defined without errors**

Open `http://localhost:5502/?fxhash=ooEmXhUTtSDuQGBZMRBQsbXR9rZApFr1pCjQnrevLLoo3yhKWxc`. No JS errors. Render is unchanged (not called yet).

- [ ] **Step 3: Commit**

```bash
git add sketch.js
git commit -m "feat: add applyPixelSort() span-based pixel sort function"
```

---

### Task 6: Call `applyPixelSort()` from `postProcessing()`

**Files:**
- Modify: `sketch.js` — add one call at the end of `postProcessing()` (~line 2150)

Current `postProcessing()` body:

```javascript
function postProcessing(graphics, cfg, pal) {
	applyAtmosphere(graphics, pal, cfg.hazeStrength);
	applyLightLeaks(
		graphics,
		pal,
		cfg.lightLeakCount,
		createRng(cfg.lightLeakSeed),
	);
	applyPostProcess(graphics, cfg.grainAmt, cfg.grainSeed);
	applyChromatic(graphics, cfg.chromaShift);
}
```

Add the pixel sort call after `applyChromatic`:

```javascript
function postProcessing(graphics, cfg, pal) {
	applyAtmosphere(graphics, pal, cfg.hazeStrength);
	applyLightLeaks(
		graphics,
		pal,
		cfg.lightLeakCount,
		createRng(cfg.lightLeakSeed),
	);
	applyPostProcess(graphics, cfg.grainAmt, cfg.grainSeed);
	applyChromatic(graphics, cfg.chromaShift);
	applyPixelSort(graphics, cfg);
}
```

- [ ] **Step 1: Add `applyPixelSort(graphics, cfg)` as the last line of `postProcessing()`**

- [ ] **Step 2: Force `config.pixelSort = true` temporarily and verify**

Temporarily change `config.pixelSort = R() < 0.15` to `config.pixelSort = true`. Open `http://localhost:5502/?fxhash=ooEmXhUTtSDuQGBZMRBQsbXR9rZApFr1pCjQnrevLLoo3yhKWxc`. Check:
- No JS errors
- Render shows visible pixel-sort streaks (horizontal or vertical depending on the seed's `pixelSortDir`)
- The mosaic structure is partially preserved — streaks appear in regions matching the threshold/target
- Render completes in a reasonable time (may be slow at 4K — a few seconds is acceptable for a one-time render)

Also test: press `s` to save — confirm the saved PNG has the sorted appearance.

- [ ] **Step 3: Revert `config.pixelSort = true` back to `R() < 0.15`**

- [ ] **Step 4: Force both modifiers simultaneously**

Temporarily set `config.newFills = true` and `config.pixelSort = true`. Reload. Confirm both modifiers apply together without errors — diagonal/radial cells AND pixel sorting visible.

- [ ] **Step 5: Revert both forced values**

- [ ] **Step 6: Smoke test several seeds**

Open the project at `http://localhost:5502` without a `?fxhash=` param — each reload generates a new random hash. Reload 10–15 times. Verify no JS errors on any seed. About 15% of loads should show new fills and 15% should show pixel sorting (with some overlap).

- [ ] **Step 7: Commit**

```bash
git add sketch.js
git commit -m "feat: call applyPixelSort() from postProcessing() to activate pixel sort modifier"
```

---

### Task 7: Push branch

- [ ] **Step 1: Push `feature/weird-mode` to remote**

```bash
git push -u origin feature/weird-mode
```

- [ ] **Step 2: Confirm push succeeded and branch is visible on remote**

```bash
git log --oneline -10
```
