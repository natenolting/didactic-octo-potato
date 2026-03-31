# Row Animation Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add spacebar-toggled scrolling animation where each mosaic row (or Rothko field zone) scrolls horizontally with a seeded direction and speed, wrapping seamlessly.

**Architecture:** A second `animatedPg` p5.Graphics buffer is composited each frame from cached `p5.Image` strips sliced from `pg`. `pg` is never modified. Strips are captured once at first spacebar press; directions and speeds are seeded from `config.animSeed` so they are deterministic per token. `draw()` branches on `animating` to show either `pg` (static) or `animatedPg` (scrolling).

**Tech Stack:** p5.js v2, vanilla JS — all changes in `sketch.js` only. No test framework; verification is visual via browser.

---

## File Structure

| File | Change |
|------|--------|
| `sketch.js` | Add globals, promote `rowHeights`, burn `config.animSeed`, export `rothkoZones`, add `initStrips()`, update `draw()` and `keyPressed()`, add `frameRate(24)` |
| `README.md` | Update UI section with new keyboard controls |

---

### Task 1: Add globals and promote `rowHeights` to module scope

**Files:**
- Modify: `sketch.js:8` — insert after `let pgReady = false;`
- Modify: `sketch.js:1359` — remove `const` from rowHeights assignment

- [ ] **Step 1: Add new globals after `let pgReady = false;` (line 8)**

The current line 8 is `let pgReady = false;`. Insert immediately after it:

```javascript
let animatedPg = null;     // animation composite buffer — same dimensions as pg
let rowStrips = [];         // p5.Image per strip, captured from pg at animation init
let rowOffsets = [];        // current x-offset per strip (pg-space pixels)
let rowDirections = [];     // +1 or -1 per strip — seeded, deterministic per token
let rowSpeeds = [];         // pixels/frame per strip — seeded, ~0.5–4 at 4K
let rowHeights = [];        // mosaic row heights in pg pixels — assigned in setup()
let rothkoZones = [];       // Rothko field zone rects — assigned in initRothkoScene()
let animating = false;      // true while animation loop is running
let stripsReady = false;    // guards one-time strip capture in initStrips()
```

- [ ] **Step 2: Promote `rowHeights` from local to module-level in setup()**

At line 1359 (inside setup, cell grid block), change:
```javascript
	const rowHeights = rawH.map((rh) =>
```
to:
```javascript
	rowHeights = rawH.map((rh) =>
```

Remove the `const` — the module-level `let rowHeights = []` now owns this variable.

> **Important:** There is also a `const rowHeights` inside `initRothkoScene`'s per-zone `for` loop (around line 2003). That one is a different local variable scoped to the loop body — leave it as `const`.

- [ ] **Step 3: Verify in browser — mosaic and Rothko**

Open `http://localhost:3000/?seed=42`. No JS errors in console. Render is visually unchanged.

Then find a Rothko seed (try seeds 1–30; look for `Composition: "Horizontal Fields"` or `"Vertical Fields"` in the console). Verify the Rothko render is also visually unchanged — this confirms the local `const rowHeights` inside `initRothkoScene`'s for loop was not accidentally affected.

- [ ] **Step 4: Commit**

```bash
git add sketch.js
git commit -m "feat: add animation globals, promote rowHeights to module scope"
```

---

### Task 2: Burn `config.animSeed` in setup()

**Files:**
- Modify: `sketch.js:1401–1403`

`config.animSeed` **must** be the very last `R()` call in setup(). The cell grid construction is the final block of `R()` calls; it ends at line 1401. Add `animSeed` after it, before the features computation comment at line 1403. Inserting it anywhere earlier would shift all downstream seeds and break the deterministic static render.

- [ ] **Step 1: Add `config.animSeed` after the cell grid (after line 1401)**

After the closing `}` of the cell grid `for` loop at line 1401, before the comment `// Compute features from the synchronously-built config.` at line 1403, insert:

```javascript
	// Animation seed — burned last so it does not shift any prior R() calls.
	// Seeded per-strip directions and speeds are deterministic per token.
	config.animSeed = Math.round(R() * 0xffffffff);
```

- [ ] **Step 2: Verify static render is unchanged**

Before committing, take a screenshot of `http://localhost:3000/?seed=42` (or note its appearance carefully). After adding `config.animSeed`, reload the same URL. The render must be **pixel-identical** to before — same cell layout, same colors, same composition. If anything shifted, `animSeed` was placed before an existing `R()` call and is breaking determinism. Check for any `R()` calls after line 1401 that you may have missed.

Also open `?seed=99` to confirm it produces a different render from `?seed=42`. No JS errors.

- [ ] **Step 3: Commit**

```bash
git add sketch.js
git commit -m "feat: burn config.animSeed for deterministic animation direction/speed"
```

---

### Task 3: Export `rothkoZones` from `initRothkoScene()`

**Files:**
- Modify: `sketch.js:2119` — just before closing `}` of `initRothkoScene`

`initRothkoScene` stores zones in a local `const zones` at line 1982. `initStrips()` needs this geometry to slice Rothko strips. Assign it to the module-level `rothkoZones` at the end of the function.

- [ ] **Step 1: Add assignment just before the closing `}` of `initRothkoScene` (line 2119)**

The closing `}` of `initRothkoScene` is at line 2119. Insert immediately before it:

```javascript
	// Expose zones to animation system — initStrips() reads this to capture per-zone strips.
	rothkoZones = zones;
```

- [ ] **Step 2: Verify with a Rothko seed**

Find a Rothko seed: open `http://localhost:3000/?seed=42`, check console for `Composition: "Horizontal Fields"` or `"Vertical Fields"`. Try seeds 1–30 until one appears. Render is unchanged. No JS errors.

- [ ] **Step 3: Commit**

```bash
git add sketch.js
git commit -m "feat: export rothkoZones from initRothkoScene for animation"
```

---

### Task 4: Add `initStrips()` function

**Files:**
- Modify: `sketch.js` — add new function immediately before `draw()` (before line 2136)

- [ ] **Step 1: Add `initStrips()` before `draw()`**

```javascript
/**
 * Captures per-strip images from pg and seeds per-strip direction/speed.
 * Called once on first spacebar press, guarded by stripsReady.
 * Mosaic: one strip per rowHeights entry, full pg width.
 * Rothko: one strip per rothkoZones entry, zone width only.
 */
function initStrips() {
	if (stripsReady) return;

	animatedPg = createGraphics(pg.width, pg.height);
	const animRng = createRng(config.animSeed);

	if (config.isRothko) {
		for (let i = 0; i < rothkoZones.length; i++) {
			const zone = rothkoZones[i];
			rowStrips[i] = pg.get(zone.x, zone.y, zone.width, zone.height);
			rowDirections[i] = animRng() < 0.5 ? -1 : 1;
			rowSpeeds[i] = 0.5 + animRng() * 3.5;
			rowOffsets[i] = 0;
		}
	} else {
		let yPos = 0;
		for (let i = 0; i < rowHeights.length; i++) {
			rowStrips[i] = pg.get(0, yPos, pg.width, rowHeights[i]);
			rowDirections[i] = animRng() < 0.5 ? -1 : 1;
			rowSpeeds[i] = 0.5 + animRng() * 3.5;
			rowOffsets[i] = 0;
			yPos += rowHeights[i];
		}
	}

	stripsReady = true;
}
```

- [ ] **Step 2: Verify no errors in browser**

Open `http://localhost:3000/?seed=42`. No JS errors. Render unchanged (initStrips not called yet).

- [ ] **Step 3: Commit**

```bash
git add sketch.js
git commit -m "feat: add initStrips() for animation strip capture"
```

---

### Task 5: Add `frameRate(24)` and update `draw()`

**Files:**
- Modify: `sketch.js:1266` — add `frameRate(24)` before `noLoop()`
- Modify: `sketch.js:2154–2157` — replace the final `image()` call in draw()

- [ ] **Step 1: Add `frameRate(24)` at the top of setup(), before `noLoop()`**

`setup()` begins at line 1262. The first two lines are `createCanvas` and `noLoop()` (line 1266). Add `frameRate(24)` immediately after `createCanvas` (line 1265), before `noLoop()`:

Change:
```javascript
	createCanvas(w, h);
	noLoop();
```
to:
```javascript
	createCanvas(w, h);
	frameRate(24);
	noLoop();
```

`noLoop()` must stay in place — `frameRate` just registers the cadence for when `loop()` is called later via spacebar.

- [ ] **Step 2: Update the tail of `draw()` to branch on `animating`**

The current draw function ends with (lines 2154–2157):
```javascript
	image(pg, 0, 0, width, height);
}
```

Replace those two lines with:
```javascript
	if (!animating) {
		image(pg, 0, 0, width, height);
		return;
	}

	// Animation frame — composite scrolling strips onto animatedPg.
	// config.bgColor is always set by the time animation runs (palette load completes before pgReady).
	animatedPg.background(config.bgColor);

	if (config.isRothko) {
		for (let i = 0; i < rothkoZones.length; i++) {
			const zone = rothkoZones[i];
			const sw = rowStrips[i].width;
			const offset = ((rowOffsets[i] % sw) + sw) % sw;
			// Clip to zone bounds — prevents bleed into margins or adjacent zones.
			animatedPg.drawingContext.save();
			animatedPg.drawingContext.beginPath();
			animatedPg.drawingContext.rect(zone.x, zone.y, zone.width, zone.height);
			animatedPg.drawingContext.clip();
			animatedPg.image(rowStrips[i], zone.x + offset,      zone.y);
			animatedPg.image(rowStrips[i], zone.x + offset - sw, zone.y);
			animatedPg.drawingContext.restore();
			rowOffsets[i] += rowSpeeds[i] * rowDirections[i];
		}
	} else {
		let yPos = 0;
		for (let i = 0; i < rowStrips.length; i++) {
			const sw = rowStrips[i].width;
			const offset = ((rowOffsets[i] % sw) + sw) % sw;
			animatedPg.image(rowStrips[i], offset,      yPos);
			animatedPg.image(rowStrips[i], offset - sw, yPos);
			rowOffsets[i] += rowSpeeds[i] * rowDirections[i];
			yPos += rowHeights[i];
		}
	}

	image(animatedPg, 0, 0, width, height);
}
```

- [ ] **Step 3: Verify static render unchanged**

Open `http://localhost:3000/?seed=42`. Render looks correct. No JS errors. Spacebar does nothing yet.

- [ ] **Step 4: Commit**

```bash
git add sketch.js
git commit -m "feat: add frameRate(24) and animation composite branch in draw()"
```

---

### Task 6: Update `keyPressed()` — spacebar and `a` key

**Files:**
- Modify: `sketch.js:2159–2164`

- [ ] **Step 1: Replace the full `keyPressed()` function**

Current (lines 2159–2164):
```javascript
function keyPressed() {
	if (key === "s" || key === "S") {
		const hash = $fx.hash || "download";
		save(pg, `${hash}.png`);
	}
}
```

Replace with:
```javascript
function keyPressed() {
	if (key === "s" || key === "S") {
		const hash = $fx.hash || "download";
		save(pg, `${hash}.png`);
	}
	if (key === "a" || key === "A") {
		if (stripsReady) {
			const hash = $fx.hash || "download";
			save(animatedPg, `${hash}-anim.png`);
		}
	}
	if (key === " ") {
		if (!pgReady) return;
		if (!stripsReady) initStrips();
		animating = !animating;
		if (animating) {
			loop();
		} else {
			noLoop();
		}
	}
}
```

- [ ] **Step 2: Verify mosaic animation**

Open `http://localhost:3000/?seed=42`. Press spacebar — rows begin scrolling horizontally. Check:
- Each row moves independently at its own speed
- Some rows go left, some right
- Rows wrap seamlessly (no gap or hard edge when a strip crosses the canvas boundary)
- Press spacebar again — animation stops, static `pg` resumes

- [ ] **Step 3: Verify determinism**

Reload `http://localhost:3000/?seed=42` twice. Press spacebar on each. Confirm the same rows scroll in the same directions at the same speeds.

- [ ] **Step 4: Verify Rothko animation**

Find a Rothko seed (try seeds 1–30, look for `Composition: "Horizontal Fields"` in console). Press spacebar. Check:
- Each field zone scrolls as a single unit
- No color bleed into margins or between zones
- Background color remains visible in margins and gaps

- [ ] **Step 5: Verify `a` key save**

Press `a` before ever pressing spacebar — nothing happens (silently ignored, no error). Press spacebar to start, then press `a` — a PNG file named `<hash>-anim.png` downloads and matches the current screen.

- [ ] **Step 6: Commit**

```bash
git add sketch.js
git commit -m "feat: spacebar toggles row animation, 'a' saves animated frame"
```

---

### Task 7: Update README

**Files:**
- Modify: `README.md`

- [ ] **Step 1: Update the UI section**

Find the current `## UI` section:
```markdown
## UI

Press "s" to save the current token as an image.
```

Replace with:
```markdown
## UI

Press **Space** to start/stop the row animation.

Press **s** to save the static render as an image.

Press **a** to save the current animated frame as an image (only available after animation has been started).
```

- [ ] **Step 2: Commit**

```bash
git add README.md
git commit -m "docs: update README with animation keyboard controls"
```
