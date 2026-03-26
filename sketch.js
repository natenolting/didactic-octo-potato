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
	pg = createGraphics(1920, 1080);
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

			config.cols = randomInt(R, 10, 100);
			config.rows = randomInt(R, 10, 100);
			config.cellwidth = pg.width / config.cols;
			config.cellheight = pg.height / config.rows;

			for (let y = 0; y < config.rows; y++) {
				for (let x = 0; x < config.cols; x++) {
					let cell = {
						x: x * config.cellwidth,
						y: y * config.cellheight,
						w: config.cellwidth,
						h: config.cellheight,
					};
					cells.push(cell);
				}
			}

			$fx.features({
				Pallet: "Pallet " + config.pallet,
				Cols: config.cols,
				Rows: config.rows,
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

function draw() {
	if (!pallet) return;
	background(111);
	pg.background(255);
	pg.noStroke();
	let newpallet = [...pallet];
	let cc = 0;
	for (let i = 0; i < cells.length; i++) {
		let cell = cells[i];
		let fc = newpallet[cc % newpallet.length];
		let nc = newpallet[(cc + 1) % newpallet.length];

		for (let g = 0; g < cell.w; g++) {
			let inter = g / cell.w;
			pg.fill(chroma.mix(fc, nc, inter, "lab").hex());
			pg.rect(cell.x + g, cell.y, 1, cell.h);
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

	image(pg, 0, 0, width, height);

	$fx.preview();
	noLoop();
}

function windowResized() {
	const { w, h } = canvasSize();
	resizeCanvas(w, h);
	redraw();
}
