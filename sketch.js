let pallets = [];
let pallet, cols, rows, cellwidth, cellheight;
let cells = [];
let pg;

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
	return floor(randomRange(rng, minValue, maxValue + 1));
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
	config.width = 1920;
	config.height = 1080;
	pg = createGraphics(config.width, config.height);
	noLoop();
	fetch("1000.json")
		.then((res) => res.json())
		.then((data) => {
			pallets = data;
			config.pallet = Math.floor(R() * pallets.length);
			pallet = [...pallets[config.pallet]];
			pallet.push(suggestColor(pallet));
			pallet.push(suggestColor(pallet));
			pallet.sort((a, b) => chroma(a).luminance() - chroma(b).luminance());

			config.cols = randomInt(R, 10, 55);
			config.rows = randomInt(R, 6, 40);
			config.cellwidth = pg.width / config.cols;
			config.bgColor = pallet[0]; // darkest palette color
			config.smears = randomInt(R, 4, 12);

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
				const brickOffset = y % 2 === 1 ? config.cellwidth * 0.5 : 0;
				const dir = R() < 0.6 ? "h" : "v";
				const mode = MODES[randomInt(R, 0, MODES.length - 1)];
				dir === "h" ? hCount++ : vCount++;

				// Odd rows get one extra cell so the brick offset doesn't gap on the right
				const numCols = y % 2 === 1 ? config.cols + 1 : config.cols;
				for (let x = 0; x < numCols; x++) {
					cells.push({
						x: x * config.cellwidth - brickOffset,
						y: yPos,
						w: config.cellwidth,
						h: cellH,
						dir,
						mode,
					});
				}
				yPos += rowHeights[y];
			}

			const totalCells = config.cols * config.rows;
			const density =
				totalCells < 120 ? "Sparse" : totalCells < 500 ? "Medium" : "Dense";
			const flowRatio = hCount / config.rows;
			const flow =
				flowRatio > 0.7 ? "Horizontal" : flowRatio < 0.3 ? "Vertical" : "Mixed";

			$fx.features({
				Pallet: "Pallet " + config.pallet,
				Density: density,
				Flow: flow,
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

function smear(source, x, y, w = 100, h = 100, d = 2) {
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

function draw() {
	if (!pallet) return;
	background(config.bgColor || "#111");
	pg.background(config.bgColor || "#111");
	pg.noStroke();
	let newpallet = [...pallet];
	let cc = 0;
	for (let i = 0; i < cells.length; i++) {
		let cell = cells[i];
		let fc = newpallet[cc % newpallet.length];
		let nc = newpallet[(cc + 1) % newpallet.length];

		if (cell.dir === "v") {
			for (let g = 0; g < cell.h; g++) {
				let inter = g / cell.h;
				pg.fill(chroma.mix(fc, nc, inter, cell.mode).hex());
				pg.rect(cell.x, cell.y + g, cell.w, 1);
			}
		} else {
			for (let g = 0; g < cell.w; g++) {
				let inter = g / cell.w;
				pg.fill(chroma.mix(fc, nc, inter, cell.mode).hex());
				pg.rect(cell.x + g, cell.y, 1, cell.h);
			}
		}

		if (i % newpallet.length === newpallet.length - 1) {
			// nc is the color this cell's gradient ends at (wraps to newpallet[0]).
			// Reshuffle, then rotate so that same color is first — next cell's fc
			// will equal this cell's nc, giving a seamless transition.
			const endColor = nc;
			newpallet = [...newpallet].sort(() => R() - 0.5);
			const idx = newpallet.indexOf(endColor);
			if (idx > 0)
				newpallet = [...newpallet.slice(idx), ...newpallet.slice(0, idx)];
			cc = -1; // cc++ below will make it 0, so next cell starts at newpallet[0]
		}
		cc++;
	}
	// Smear effect, take portions of pg and draw them repeatedly to appear to stretch the pixels
	for (let i = 0; i < config.smears; i++) {
		smear(
			pg,
			randomInt(R, 0, config.width * 2),
			randomInt(R, 0, config.height * 2),
			randomInt(R, 0, config.width * 2),
			randomInt(R, 0, config.height * 2),
			randomInt(R, 1, 4),
		);
	}

	image(pg, 0, 0, width, height);

	$fx.preview();
	noLoop();
}

function windowResized() {
	const { w, h } = canvasSize();
	resizeCanvas(w, h);
	redraw();
}
