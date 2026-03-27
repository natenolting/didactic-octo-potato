let pallets = [];
let pallet, cols, rows;
let cells = [];
let pg;
// full size file, 4K
const fullWidth = 3840;
const fullHeight = 2160;

// Reproducible RNG — use R() everywhere instead of $fx.rand() or random().
// Prod (no ?seed param): delegates to $fx.rand(), seeded by the token hash.
// Dev  (?seed=42):       uses a local mulberry32 RNG so any integer reproduces the render.
const _seedParam = new URLSearchParams(location.search).get("seed");
const R = (() => {
	if (_seedParam === null) return () => $fx.rand();
	let s = parseInt(_seedParam, 10) >>> 0 || 1;
	return () => {
		s |= 0;
		s = (s + 0x6d2b79f5) | 0;
		let t = Math.imul(s ^ (s >>> 15), 1 | s);
		t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
})();

function createRng(seed) {
	let value = seed >>> 0;

	// Small fast seeded RNG: enough determinism for our purposes, and much faster than cryptographic hashes.
	return function rng() {
		value += 0x6d2b79f5;
		let next = value;
		next = Math.imul(next ^ (next >>> 15), next | 1);
		next ^= next + Math.imul(next ^ (next >>> 7), next | 61);
		return ((next ^ (next >>> 14)) >>> 0) / 4294967296;
	};
}

function randomRange(rng, minValue, maxValue) {
	return minValue + (maxValue - minValue) * rng();
}

function randomInt(rng, minValue, maxValue) {
	return Math.floor(randomRange(rng, minValue, maxValue + 1));
}

const config = {};

/**
 * Suggests a harmonious new color for the given palette.
 * Picks a hue at the largest gap in the existing hue wheel,
 * then adjusts luminance to fill whichever tonal role is missing
 * (dark anchor, light anchor, or mid-tone).
 * Requires chroma.js to be loaded.
 * @param {string[]} pal - Array of hex color strings.
 * @returns {string} Suggested hex color.
 */
function suggestColor(pal) {
	const DARK_THRESHOLD = 0.1;
	const LIGHT_THRESHOLD = 0.6;

	const lums = pal.map((c) => chroma(c).luminance());
	const hasDark = lums.some((l) => l < DARK_THRESHOLD);
	const hasLight = lums.some((l) => l > LIGHT_THRESHOLD);
	const lchs = pal.map((c) => chroma(c).lch());

	const hues = lchs.map((lch) => lch[2]).sort((a, b) => a - b);
	let maxHueGap = 0,
		gapStart = hues[hues.length - 1];
	for (let i = 0; i < hues.length; i++) {
		const next = hues[(i + 1) % hues.length];
		const gap = (next - hues[i] + 360) % 360;
		if (gap > maxHueGap) {
			maxHueGap = gap;
			gapStart = hues[i];
		}
	}
	const novelH = (gapStart + maxHueGap / 2) % 360;
	const avgC = lchs.reduce((s, lch) => s + lch[1], 0) / lchs.length;

	if (!hasDark) return chroma.lch(18, Math.min(avgC * 0.9, 45), novelH).hex();
	if (!hasLight) return chroma.lch(92, Math.min(avgC * 0.3, 18), novelH).hex();
	const avgL = lchs.reduce((s, lch) => s + lch[0], 0) / lchs.length;
	return chroma.lch(avgL, avgC, novelH).hex();
}

function canvasSize() {
	const scale = Math.min(windowWidth / 1920, windowHeight / 1080);
	return { w: Math.floor(1920 * scale), h: Math.floor(1080 * scale) };
}

function setup() {
	const { w, h } = canvasSize();
	createCanvas(w, h);
	config.width = fullWidth;
	config.height = fullHeight;
	pg = createGraphics(config.width, config.height);
	noLoop();
	// Seed p5's Perlin noise so outputs are deterministic for a given token/seed.
	noiseSeed(Math.round(R() * 0xffffffff));
	fetch("1000.json")
		.then((res) => res.json())
		.then((data) => {
			pallets = data;
			config.pallet = Math.floor(R() * pallets.length);
			pallet = [...pallets[config.pallet]];
			pallet.push(suggestColor(pallet));
			pallet.push(suggestColor(pallet));
			pallet.sort((a, b) => chroma(a).luminance() - chroma(b).luminance());

			config.cols = randomInt(R, 6, 22);
			config.rows = randomInt(R, 5, 14);
			config.cellwidth = pg.width / config.cols;
			config.bgColor = pallet[0]; // darkest palette color
			config.smears = randomInt(R, 2, 6);
			config.squareWaves = randomInt(R, 2, 4);
			//config.vigStrength = 0.45 + R() * 0.45; // 0.45–0.9
			config.vigStrength = 0; // 0.45–0.9
			config.grainAmt = 8 + R() * 14; // 8–22 per channel
			config.grainSeed = Math.round(R() * 0xffffffff);
			config.chromaShift = floor(1 + R() * 4); // 1–4 px channel split
			config.hazeStrength = 0.12 + R() * 0.3; // 0.12–0.42 atmospheric fade
			config.lightLeakCount = randomInt(R, 2, 6);
			config.lightLeakSeed = Math.round(R() * 0xffffffff);
			config.captureCells = randomInt(R, 5, 10);
			config.pixelationLevels = [
				randomInt(R, 2, 4),
				randomInt(R, 5, 10),
				randomInt(R, 12, 20),
			];
			// Variable row heights — random weights, normalized to fill pg.height exactly.
			const GAP = 0; // px gap between rows (shows bgColor)
			const rawH = Array.from({ length: config.rows }, () => 0.3 + R() * 1.7);
			const totalRaw = rawH.reduce((a, b) => a + b, 0);
			const rowHeights = rawH.map((h) =>
				Math.max(3, Math.round((h / totalRaw) * pg.height)),
			);
			const hDrift = pg.height - rowHeights.reduce((a, b) => a + b, 0);
			rowHeights[rowHeights.length - 1] = Math.max(
				3,
				rowHeights[rowHeights.length - 1] + hDrift,
			);

			const MODES = ["lab", "lch", "hsl"];
			let hCount = 0,
				vCount = 0;
			let yPos = 0;
			for (let y = 0; y < config.rows; y++) {
				const cellH = Math.max(2, rowHeights[y] - GAP);
				// Bias gradient direction: horizontal at top (sky), more vertical lower (terrain)
				const rowNorm = y / config.rows;
				const hProb = rowNorm < 0.4 ? 0.85 : rowNorm < 0.7 ? 0.6 : 0.35;
				const dir = R() < hProb ? "h" : "v";
				const mode = MODES[randomInt(R, 0, MODES.length - 1)];
				dir === "h" ? hCount++ : vCount++;

				// Rest zones: sky and ground rows can use fewer, wider cells for breathing room
				const isRestZone =
					(rowNorm < 0.45 && R() < 0.4) || (rowNorm > 0.75 && R() < 0.3);
				const restDivisor = isRestZone ? randomInt(R, 2, 4) : 1;
				const rowCols = Math.max(2, Math.floor(config.cols / restDivisor));
				const rowCellW = pg.width / rowCols;
				const rowOffset = y % 2 === 1 ? rowCellW * 0.5 : 0;
				const numCols = y % 2 === 1 ? rowCols + 1 : rowCols;

				for (let x = 0; x < numCols; x++) {
					cells.push({
						x: x * rowCellW - rowOffset,
						y: yPos,
						w: rowCellW,
						h: cellH,
						dir,
						mode,
					});
				}
				yPos += rowHeights[y];
			}

			const totalCells = config.cols * config.rows;
			const density =
				totalCells < 60 ? "Sparse" : totalCells < 160 ? "Medium" : "Dense";
			const flowRatio = hCount / config.rows;
			const flow =
				flowRatio > 0.7 ? "Horizontal" : flowRatio < 0.3 ? "Vertical" : "Mixed";

			const vibe =
				config.vigStrength < 0.55
					? "Open"
					: config.vigStrength < 0.72
						? "Focused"
						: "Dramatic";

			const clarity =
				config.chromaShift <= 1
					? "Sharp"
					: config.chromaShift <= 3
						? "Soft"
						: "Dreamy";

			$fx.features({
				Pallet: "Pallet " + config.pallet,
				Density: density,
				Flow: flow,
				Vibe: vibe,
				Clarity: clarity,
			});
			console.log(
				"seed:",
				_seedParam ?? $fx.hash,
				"features:",
				$fx.getFeatures(),
			);

			redraw();
		});
}

function drawSmear(source, x, y, w = 100, h = 100, d = 2) {
	source.loadPixels();
	const pw = source.width;
	const ph = source.height;
	const pixels = source.pixels;

	function getPixel(px, py) {
		if (px < 0 || px >= pw || py < 0 || py >= ph) return null;
		const idx = (py * pw + px) * 4;
		return [pixels[idx], pixels[idx + 1], pixels[idx + 2], pixels[idx + 3]];
	}

	function setPixel(px, py, c) {
		if (px < 0 || px >= pw || py < 0 || py >= ph) return;
		const idx = (py * pw + px) * 4;
		pixels[idx] = c[0];
		pixels[idx + 1] = c[1];
		pixels[idx + 2] = c[2];
		pixels[idx + 3] = c[3];
	}

	let selection = [];
	switch (d) {
		case 1:
			// north
			for (let i = 0; i < w; i++) {
				const p = getPixel(x + i, y);
				if (p) selection.push(p);
			}
			for (let j = 0; j < h; j++) {
				for (let s = 0; s < selection.length; s++) {
					setPixel(x + s, y - j, selection[s]);
				}
			}
			break;
		case 2:
			// east
			for (let i = 0; i < h; i++) {
				const p = getPixel(x, y + i);
				if (p) selection.push(p);
			}
			for (let j = 0; j < w; j++) {
				for (let s = 0; s < selection.length; s++) {
					setPixel(x + j, y + s, selection[s]);
				}
			}
			break;
		case 3:
			// south
			for (let i = 0; i < w; i++) {
				const p = getPixel(x + i, y);
				if (p) selection.push(p);
			}
			for (let j = 0; j < h; j++) {
				for (let s = 0; s < selection.length; s++) {
					setPixel(x + s, y + j, selection[s]);
				}
			}
			break;
		case 4:
			// west
			for (let i = 0; i < h; i++) {
				const p = getPixel(x, y + i);
				if (p) selection.push(p);
			}
			for (let j = 0; j < w; j++) {
				for (let s = 0; s < selection.length; s++) {
					setPixel(x - j, y + s, selection[s]);
				}
			}
			break;
		default:
			break;
	}

	source.updatePixels();
}

/**
 * Applies atmospheric haze — fades the top portion of the canvas toward
 * the lightest palette color, simulating aerial perspective / sky wash.
 * @param {p5.Graphics} source
 * @param {string[]} pal - Palette sorted darkest-to-lightest.
 * @param {number} strength - 0–1, peak opacity of the haze at the top edge.
 */
function applyAtmosphere(source, pal, strength) {
	source.loadPixels();
	const w = source.width,
		h = source.height;
	const pix = source.pixels;
	const [hr, hg, hb] = chroma(pal[pal.length - 1])
		.desaturate(0.8)
		.rgb();

	for (let y = 0; y < h; y++) {
		const yNorm = y / h;
		// Haze strongest at top, fading to zero around 45% down
		const haze = Math.max(0, 1 - yNorm / 0.45) * strength;
		if (haze <= 0) break; // rows below 45% get nothing
		for (let x = 0; x < w; x++) {
			const idx = (y * w + x) << 2;
			pix[idx] = (pix[idx] + (hr - pix[idx]) * haze) | 0;
			pix[idx + 1] = (pix[idx + 1] + (hg - pix[idx + 1]) * haze) | 0;
			pix[idx + 2] = (pix[idx + 2] + (hb - pix[idx + 2]) * haze) | 0;
		}
	}
	source.updatePixels();
}

/**
 * Applies vignette and film grain to a graphics buffer in a single pixel pass.
 * Vignette blends each pixel toward bgHex based on distance from center.
 * Grain adds deterministic per-pixel luminance noise using a seeded RNG.
 * @param {p5.Graphics} source
 * @param {string} bgHex - darkest palette color, used for vignette target
 * @param {number} vigStrength - 0–1, how strongly the vignette blends (0=none, 1=full black edges)
 * @param {number} grainAmt - max per-channel noise in 0–255 range
 * @param {number} grainSeed - integer seed for the grain RNG (deterministic)
 */
function applyPostProcess(source, bgHex, vigStrength, grainAmt, grainSeed) {
	source.loadPixels();
	const w = source.width,
		h = source.height;
	const cx = w * 0.5,
		cy = h * 0.5;
	const [dr, dg, db] = chroma(bgHex).rgb();
	const pix = source.pixels;
	const grain = createRng(grainSeed);

	for (let y = 0; y < h; y++) {
		const ny = (y - cy) / cy;
		const ny2 = ny * ny;
		for (let x = 0; x < w; x++) {
			const nx = (x - cx) / cx;
			// Use squared distance to avoid sqrt — smooth ramp from r=0.5 to r=1.2
			const distSq = nx * nx + ny2;
			const vig =
				Math.min(1, Math.max(0, (distSq - 0.25) / 1.19)) * vigStrength;
			const noise = (grain() - 0.5) * 2 * grainAmt;
			const idx = (y * w + x) << 2;
			pix[idx] = Math.min(
				255,
				Math.max(0, (pix[idx] + (dr - pix[idx]) * vig + noise) | 0),
			);
			pix[idx + 1] = Math.min(
				255,
				Math.max(0, (pix[idx + 1] + (dg - pix[idx + 1]) * vig + noise) | 0),
			);
			pix[idx + 2] = Math.min(
				255,
				Math.max(0, (pix[idx + 2] + (db - pix[idx + 2]) * vig + noise) | 0),
			);
		}
	}
	source.updatePixels();
}

/**
 * Applies horizontal chromatic aberration to a graphics buffer.
 * Shifts the red channel left by `shift` pixels and the blue channel right
 * by `shift` pixels; green stays in place as the anchor.
 * Reads from a frozen copy of the pixel array so no channel bleeds into another.
 * @param {p5.Graphics} source
 * @param {number} shift - integer pixel offset (1–7 typical)
 */
function applyChromatic(source, shift) {
	source.loadPixels();
	const w = source.width,
		h = source.height;
	const src = new Uint8ClampedArray(source.pixels); // frozen snapshot
	const pix = source.pixels;
	const s = Math.round(shift);

	for (let y = 0; y < h; y++) {
		const row = y * w;
		for (let x = 0; x < w; x++) {
			const idx = (row + x) << 2;

			// Red: pull from x - s
			const rx = x - s;
			pix[idx] = rx >= 0 ? src[(row + rx) << 2] : src[idx];

			// Green: unchanged
			pix[idx + 1] = src[idx + 1];

			// Blue: pull from x + s
			const bx = x + s;
			pix[idx + 2] = bx < w ? src[((row + bx) << 2) + 2] : src[idx + 2];
		}
	}
	source.updatePixels();
}

/**
 * Draws semi-transparent color bars bleeding in from the canvas edges,
 * simulating film light leaks. Each leak is a gradient that peaks at the
 * edge and fades to transparent inward. Uses bright palette colors and a
 * sub-RNG so positions are deterministic without consuming the main R() stream.
 * @param {p5.Graphics} graphics
 * @param {string[]} pal - Palette sorted darkest→lightest.
 * @param {number} count - Number of leaks to draw.
 * @param {Function} rng - Seeded sub-RNG (use createRng(config.lightLeakSeed)).
 */
function applyLightLeaks(graphics, pal, count, rng) {
	const w = graphics.width,
		h = graphics.height;
	const ctx = graphics.drawingContext;

	for (let i = 0; i < count; i++) {
		// Bias toward brighter palette entries (upper half, sorted dark→light)
		const ci = Math.min(
			Math.floor(pal.length * 0.5 + rng() * pal.length * 0.5),
			pal.length - 1,
		);
		const [r, g, b] = chroma(pal[ci]).brighten(0.4).rgb();
		const peakAlpha = 0.1 + rng() * 0.25; // 10–35 % at the hard edge

		const isVertical = rng() < 0.6; // vertical bars more common than horizontal

		if (isVertical) {
			const onLeft = rng() < 0.5;
			const barW = w * (0.05 + rng() * 0.14); // 5–19 % of width
			const yStart = rng() * h * 0.4;
			const barH = h * (0.3 + rng() * 0.7);
			// Gradient runs from the hard edge inward to transparent
			const grad = ctx.createLinearGradient(
				onLeft ? 0 : w,
				0,
				onLeft ? barW : w - barW,
				0,
			);
			grad.addColorStop(0, `rgba(${r},${g},${b},${peakAlpha})`);
			grad.addColorStop(1, `rgba(${r},${g},${b},0)`);
			ctx.fillStyle = grad;
			ctx.fillRect(onLeft ? 0 : w - barW, yStart, barW, barH);
		} else {
			const onTop = rng() < 0.5;
			const barH = h * (0.04 + rng() * 0.12); // 4–16 % of height
			const xStart = rng() * w * 0.4;
			const barW = w * (0.4 + rng() * 0.6);
			const grad = ctx.createLinearGradient(
				0,
				onTop ? 0 : h,
				0,
				onTop ? barH : h - barH,
			);
			grad.addColorStop(0, `rgba(${r},${g},${b},${peakAlpha})`);
			grad.addColorStop(1, `rgba(${r},${g},${b},0)`);
			ctx.fillStyle = grad;
			ctx.fillRect(xStart, onTop ? 0 : h - barH, barW, barH);
		}
	}
}

/**
 * Draws a single square wave across one row of the cell grid.
 * Picks a row to start from using Perlin noise, then walks its cells
 * left-to-right, stair-stepping between top and bottom edges at each
 * cell boundary based on Perlin noise.
 * @param {p5.Graphics} graphics - Target graphics buffer.
 * @param {Array<{x:number,y:number,w:number,h:number}>} cellList - All cells.
 * @param {string[]} pal - Palette array sorted darkest-to-lightest.
 * @param waveIndex - integer index of the wave (0,1,2...) to ensure different noise patterns if multiple waves are drawn
 */
function drawSquareWave(graphics, cellList, pal, waveIndex = 0) {
	const noiseScale = 0.28;
	// Unique offset per wave so each one picks a different row and path.
	const wo = waveIndex * 13.7;

	// Group cells into rows sorted top-to-bottom.
	const rowMap = new Map();
	for (const cell of cellList) {
		if (!rowMap.has(cell.y)) rowMap.set(cell.y, []);
		rowMap.get(cell.y).push(cell);
	}
	const sortedRows = [...rowMap.entries()]
		.sort(([a], [b]) => a - b)
		.map(([, rowCells]) => rowCells.sort((a, b) => a.x - b.x));

	// Pick starting row — biased toward the vertical center for horizon effect.
	const rawRi = noise(42 + wo, 7 + wo);
	const ri = floor((0.25 + rawRi * 0.5) * sortedRows.length);
	const rowCells = sortedRows[ri]; // x-column structure comes from this row
	if (!rowCells || rowCells.length === 0) return;

	// Active row index — the wave can drift up/down through rows as it walks.
	let rowIdx = ri;

	// Starting edge: noise decides top or bottom of the first cell.
	const startHigh = noise(wo, ri * noiseScale + wo) > 0.5;
	let curY = startHigh
		? sortedRows[rowIdx][0].y
		: sortedRows[rowIdx][0].y + sortedRows[rowIdx][0].h;

	const [fr, fg, fb] = chroma(pal[randomInt(R, 0, pal.length - 1)]).rgb();
	const gh = graphics.height;
	const ctx = graphics.drawingContext;

	for (let ci = 0; ci < rowCells.length; ci++) {
		const cell = rowCells[ci];

		// Solid stroke at the wave edge
		ctx.fillStyle = `rgba(${fr},${fg},${fb},1)`;
		ctx.fillRect(cell.x, curY, cell.w, cell.h);

		// Short, soft gradient below the stroke
		const reach = Math.min(gh * 0.3, gh - curY); // fade over 30% of canvas max
		const grad = ctx.createLinearGradient(0, curY, 0, curY + reach);
		grad.addColorStop(0, `rgba(${fr},${fg},${fb},.55)`);
		grad.addColorStop(0.4, `rgba(${fr},${fg},${fb},.2)`);
		grad.addColorStop(1, `rgba(${fr},${fg},${fb},0)`);
		ctx.fillStyle = grad;
		ctx.fillRect(cell.x, curY + 2, cell.w, reach);

		if (ci < rowCells.length - 1) {
			// At the junction, noise decides: continue / jump to row above / jump to row below.
			const n = noise((ci + 1) * noiseScale + wo, rowIdx * noiseScale + wo);
			let nextY = curY;

			if (n < 0.33 && rowIdx > 0) {
				// Jump up — land on the TOP edge of the row above.
				rowIdx--;
				const above = sortedRows[rowIdx];
				nextY = above[min(ci + 1, above.length - 1)].y;
			} else if (n > 0.67 && rowIdx < sortedRows.length - 1) {
				// Jump down — land on the BOTTOM edge of the row below.
				rowIdx++;
				const below = sortedRows[rowIdx];
				nextY =
					below[min(ci + 1, below.length - 1)].y +
					below[min(ci + 1, below.length - 1)].h;
			}
			curY = nextY;
		}
	}
}

function applyCells(graphics, pallet, cells) {
	let newPallet = [...pallet];
	let cc = 0;
	for (let i = 0; i < cells.length; i++) {
		let cell = cells[i];

		// Bias palette index by vertical position: top → lighter, bottom → darker.
		// pallet is sorted dark[0] → light[last], so invert yNorm.
		const yNorm = cell.y / graphics.height;
		const yBias = floor((1 - yNorm) * newPallet.length * 0.75);
		const biasedCc = (cc + yBias) % newPallet.length;

		let fc = newPallet[biasedCc % newPallet.length];
		let nc = newPallet[(biasedCc + 1) % newPallet.length];

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

		if (i % newPallet.length === newPallet.length - 1) {
			// Consume the same RNG calls for compatibility, then re-sort by luminance
			// so the vertical position bias always indexes light→dark correctly.
			[...newPallet].sort(() => R() - 0.5);
			newPallet = [...pallet]; // reset to luminance-sorted original
			cc = -1;
		}
		cc++;
	}
}

function applySmear(graphics, smears) {
	for (let i = 0; i < smears; i++) {
		const sx = randomInt(R, 0, config.width);
		const sy = randomInt(R, 0, config.height);
		const sw = randomInt(R, 20, config.width * 0.6);
		const sh = randomInt(R, 10, config.height * 0.3);
		const baseDir = randomInt(R, 1, 4);
		// In the upper half, remap vertical dirs (1=N,3=S) to horizontal (2=E,4=W)
		const sd =
			sy < config.height * 0.5 && (baseDir === 1 || baseDir === 3)
				? baseDir + 1
				: baseDir;
		drawSmear(graphics, sx, sy, sw, sh, sd);
	}
}

function applySquareWave(graphics, cells, pallet, waves) {
	// square wave
	for (let i = 0; i < waves; i++) {
		drawSquareWave(graphics, cells, pallet, i);
	}
}

function captureCells(graphics, cells) {
	let capture = [];
	for (let i = 0; i < cells.length; i++) {
		const cell = cells[i];
		const img = graphics.get(cell.x, cell.y, cell.w, cell.h);
		capture.push(img);
	}
	return capture;
}

function drawPixelation(graphics, source, x, y, level) {
	const w = source.width;
	const h = source.height;

	let rectW = w / level;
	let rectH = h / level;

	for (let i = 0; i < w; i += rectW) {
		for (let j = 0; j < h; j += rectH) {
			const gp = source.get(i, j);
			graphics.fill(gp);
			graphics.noStroke();
			graphics.rect(
				x + i,
				y + j,
				Math.min(rectW, w - i),
				Math.min(rectH, h - j),
			);
		}
	}
}

// initate the scene by applying all effects in order
function initScene(graphics, config, pallet, cells) {
	graphics.background(config.bgColor || "#111");
	graphics.noStroke();

	// Core cell structure with gradient fills
	applyCells(graphics, pallet, cells);

	// capture cells for later
	const newCells = shuffle([...cells])
		.sort((a, b) => b.w * b.h - a.w * a.h)
		.slice(0, config.captureCells);
	const capture = captureCells(graphics, newCells);

	// Atmospheric haze — sky wash on the upper portion
	applyAtmosphere(graphics, pallet, config.hazeStrength);

	// Smear effect — biased horizontal in upper half (clouds), random in lower half (terrain)
	applySmear(graphics, config.smears);

	// Square wave effect
	applySquareWave(graphics, cells, pallet, config.squareWaves);

	//use the captured cells
	for (let i = 0; i < capture.length; i++) {
		drawPixelation(
			graphics,
			capture[i],
			newCells[i].x,
			newCells[i].y,
			randomInt(R, ...config.pixelationLevels),
		);
	}
	// Light leaks — soft color bars bleeding in from canvas edges
	applyLightLeaks(
		graphics,
		pallet,
		config.lightLeakCount,
		createRng(config.lightLeakSeed),
	);

	// Vignette + film grain in a single pixel pass
	applyPostProcess(
		graphics,
		config.bgColor || "#111",
		config.vigStrength,
		config.grainAmt,
		config.grainSeed,
	);

	// Chromatic aberration — RGB channel split
	applyChromatic(graphics, config.chromaShift);
}

function draw() {
	if (!pallet) return;
	background(config.bgColor || "#111");

	initScene(pg, config, pallet, cells);
	image(pg, 0, 0, width, height);

	$fx.preview();
	noLoop();
}

function keyPressed() {
	if (key === "s" || key === "S") {
		const hash = $fx.hash || "download";
		save(pg, `${hash}.png`);
	}
}

function windowResized() {
	const { w, h } = canvasSize();
	resizeCanvas(w, h);
	redraw();
}
