let palettes = [];
let palette, cols, rows;
let cells = [];
let pg;
// Tracks canvas orientation for the current token — set in setup() after palette load.
// canvasSize() reads this to produce the correct aspect ratio for the display canvas.
let isPortrait = false;
let pgReady = false;
let animatedPg = null; // animation composite buffer — same dimensions as pg
let rowStrips = []; // p5.Image per strip, captured from pg at animation init
let rowOffsets = []; // current x-offset per strip (pg-space pixels)
let rowDirections = []; // +1 or -1 per strip — seeded, deterministic per token
let rowSpeeds = []; // pixels/frame per strip — seeded, ~0.5–4 at 4K
let rowHeights = []; // mosaic row heights in pg pixels — assigned in setup()
let rowDrawHeights = []; // strip heights used for draw() compositing — equals rowHeights for mosaic, equal divisions for Rothko
let rothkoZones = []; // Rothko field zone rects — assigned in initRothkoScene()
let animating = false; // true while animation loop is running
let stripsReady = false; // guards one-time strip capture in initStrips()
// full size file, 4K
const fullWidth = 3840;
const fullHeight = 2160;

// Reproducible RNG — use R() everywhere instead of $fx.rand() or random().
// Prod (no ?seed param): delegates to $fx.rand(), seeded by the token hash.
// Dev  (?seed=42):       uses a local mulberry32 RNG so any integer reproduces the render.
const _seedParam = new URLSearchParams(location.search).get("seed");
// If ?seed= holds a non-numeric fxhash hash string, redirect to ?fxhash= so
// the SDK seeds $fx.rand() correctly. ?seed= is for integer dev seeds only.
if (_seedParam !== null && isNaN(parseInt(_seedParam, 10))) {
	const _url = new URL(location.href);
	_url.searchParams.set("fxhash", _seedParam);
	_url.searchParams.delete("seed");
	location.replace(_url.toString());
}
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

// Deterministic Fisher-Yates shuffle using R() — use instead of p5's shuffle().
function shuffleR(arr) {
	const a = [...arr];
	for (let i = a.length - 1; i > 0; i--) {
		const j = Math.floor(R() * (i + 1));
		[a[i], a[j]] = [a[j], a[i]];
	}
	return a;
}

function randomInt(rng, minValue, maxValue) {
	return Math.floor(randomRange(rng, minValue, maxValue + 1));
}

const config = {};

/**
 * Returns the average pairwise CIE76 deltaE across all color pairs in pal.
 * Used to detect low-contrast palettes before Rothko Mode rendering.
 * @param {string[]} pal - Array of hex color strings.
 * @returns {number}
 */
function paletteDeltaE(pal) {
	const labs = pal.map((c) => chroma(c).lab());
	let total = 0,
		count = 0;
	for (let a = 0; a < labs.length; a++) {
		for (let b = a + 1; b < labs.length; b++) {
			const [l1, a1, b1] = labs[a],
				[l2, a2, b2] = labs[b];
			total += Math.sqrt((l1 - l2) ** 2 + (a1 - a2) ** 2 + (b1 - b2) ** 2);
			count++;
		}
	}
	return count > 0 ? total / count : 0;
}

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

	// Filter out NaN hues — achromatic colors (grays, black, white) have no hue in LCH.
	// Without this, NaN propagates into novelH and causes chroma.lch() to throw,
	// which bubbles up through the fetch .then() chain to .catch(), where $fx.preview()
	// fires on an unrendered white canvas, producing blank outputs.
	const hues = lchs
		.map((lch) => lch[2])
		.filter((h) => !isNaN(h))
		.sort((a, b) => a - b);
	let maxHueGap = 0,
		gapStart = hues.length > 0 ? hues[hues.length - 1] : 0;
	for (let i = 0; i < hues.length; i++) {
		const next = hues[(i + 1) % hues.length];
		const gap = (next - hues[i] + 360) % 360;
		if (gap > maxHueGap) {
			maxHueGap = gap;
			gapStart = hues[i];
		}
	}
	// Fall back to hue 0 when every palette color is achromatic.
	const novelH = hues.length > 0 ? (gapStart + maxHueGap / 2) % 360 : 0;
	const avgC =
		lchs.reduce((s, lch) => s + (isNaN(lch[1]) ? 0 : lch[1]), 0) / lchs.length;

	if (!hasDark) return chroma.lch(18, Math.min(avgC * 0.9, 45), novelH).hex();
	if (!hasLight) return chroma.lch(92, Math.min(avgC * 0.3, 18), novelH).hex();
	const avgL = lchs.reduce((s, lch) => s + lch[0], 0) / lchs.length;
	return chroma.lch(avgL, avgC, novelH).hex();
}

/**
 * Splits the palette into `count` hue-distinct clusters so each Rothko
 * field can be assigned its own color family.
 *
 * Approach: sort colors by LCH hue angle and divide evenly into groups.
 * LCH hue gives perceptually uniform spacing — better than HSL for this.
 *
 * Fallback: if total hue spread is < 60° (near-neutral/greyscale palette),
 * hue clustering would produce near-identical groups. In that case we fall
 * back to luminance order (the palette is already sorted dark→light) so each
 * field still gets visually distinct colors.
 *
 * @param {string[]} pal - Palette hex strings (any order accepted).
 * @param {number} count - Number of clusters to produce (matches fieldCount).
 * @returns {string[][]} Array of `count` sub-palettes, each an array of hex strings.
 */
function clusterByHue(pal, count) {
	const withHue = pal.map((c) => ({ c, h: chroma(c).lch()[2] || 0 }));
	const hues = withHue.map((x) => x.h);
	const spread = Math.max(...hues) - Math.min(...hues);

	// Low hue variance → fall back to luminance order (palette already sorted dark→light)
	const sorted =
		spread < 60 ? [...pal] : withHue.sort((a, b) => a.h - b.h).map((x) => x.c);

	// Divide sorted colors evenly into count groups
	const size = Math.ceil(sorted.length / count);
	const clusters = Array.from({ length: count }, (_, i) =>
		sorted.slice(i * size, (i + 1) * size),
	);

	// Guard: ensure no empty cluster (edge case with very small palettes)
	return clusters.map((cl, i) =>
		cl.length > 0 ? cl : [sorted[i % sorted.length]],
	);
}

/**
 * Computes the bounding rectangle for each Rothko color field.
 *
 * Layout logic:
 * - fieldMargin is subtracted from all four canvas sides, so the background
 *   color is always visible as a border around the entire composition.
 * - Fields are separated by fieldGap strips (also shows background color).
 * - Horizontal orientation: fields are stacked top-to-bottom, each spanning
 *   the full usable width. Heights are randomly weighted.
 * - Vertical orientation: fields are arranged left-to-right, each spanning
 *   the full usable height. Widths are randomly weighted.
 *
 * @param {object} cfg - config with width, height, fieldCount, fieldGap,
 *                       fieldMargin, rothkoOrientation.
 * @returns {Array<{x:number, y:number, width:number, height:number}>}
 */
function buildRothkoZones(cfg) {
	const isVertical = cfg.rothkoOrientation === "vertical";

	// Canvas area available after removing margins on all four sides
	const usableW = cfg.width - cfg.fieldMargin * 2;
	const usableH = cfg.height - cfg.fieldMargin * 2;
	// Total space consumed by the gaps between fields
	const totalGap = cfg.fieldGap * (cfg.fieldCount - 1);

	// Field size weights vary by proportion mode.
	// Balanced:  roughly equal random weights (original behavior).
	// Dominant:  one field gets 3–5× the weight; others are subordinate.
	// Staggered: alternating large/small weights (even indices large, odd small).
	let rawSizes;
	if (cfg.rothkoProportionMode === "dominant") {
		rawSizes = Array.from(
			{ length: cfg.fieldCount },
			(_, i) =>
				i === cfg.rothkoDominantIdx
					? 3.0 + R() * 2.0 // dominant field: 3–5× weight
					: 0.3 + R() * 0.5, // subordinate fields: smaller
		);
	} else if (cfg.rothkoProportionMode === "staggered") {
		rawSizes = Array.from(
			{ length: cfg.fieldCount },
			(_, i) =>
				i % 2 === 0
					? 0.8 + R() * 0.6 // large
					: 0.2 + R() * 0.3, // small
		);
	} else {
		// balanced
		rawSizes = Array.from({ length: cfg.fieldCount }, () => 0.6 + R() * 0.8);
	}
	const totalRaw = rawSizes.reduce((a, b) => a + b, 0);
	const usableSpan = (isVertical ? usableW : usableH) - totalGap;
	const sizes = rawSizes.map((s) =>
		Math.max(10, Math.round((s / totalRaw) * usableSpan)),
	);
	// Correct any rounding drift so fields fill the span exactly
	const drift = usableSpan - sizes.reduce((a, b) => a + b, 0);
	sizes[sizes.length - 1] = Math.max(10, sizes[sizes.length - 1] + drift);

	const zones = [];
	let pos = cfg.fieldMargin; // cursor that advances across the stacking axis
	for (let i = 0; i < cfg.fieldCount; i++) {
		if (isVertical) {
			// Vertical layout: advance left-to-right; height spans full usable height
			zones.push({
				x: pos,
				y: cfg.fieldMargin,
				width: sizes[i],
				height: usableH,
			});
		} else {
			// Horizontal layout: advance top-to-bottom; width spans full usable width
			zones.push({
				x: cfg.fieldMargin,
				y: pos,
				width: usableW,
				height: sizes[i],
			});
		}
		pos += sizes[i] + cfg.fieldGap;
	}
	return zones;
}

function canvasSize() {
	// Swap base dimensions for portrait orientation (isPortrait set in setup after palette load).
	const baseW = isPortrait ? fullHeight : fullWidth;
	const baseH = isPortrait ? fullWidth : fullHeight;
	const scale = Math.min(windowWidth / baseW, windowHeight / baseH);
	return { w: Math.floor(baseW * scale), h: Math.floor(baseH * scale) };
}

const PALETTE_NAMES = [
	"Bright Sienna",
	"Light Rust",
	"Rich Ember",
	"Bold Sienna",
	"Light Sienna",
	"Moody Teal",
	"Vivid Sienna",
	"Cool Moss",
	"Rich Copper",
	"Light Scarlet",
	"Bright Rust",
	"Linen",
	"Light Citrine",
	"Earthy Copper",
	"Moody Seafoam",
	"Soft Ember",
	"Vivid Amber",
	"Warm Ember",
	"Bold Amber",
	"Bright Fern",
	"Earthy Scarlet",
	"Bold Ochre",
	"Soft Citrine",
	"Bold Ochre II",
	"Vivid Rust",
	"Bright Ochre",
	"Earthy Crimson",
	"Cool Pine",
	"Vivid Sage",
	"Bold Amber II",
	"Rich Rust",
	"Bold Copper",
	"Muted Gold",
	"Bold Sienna II",
	"Deep Fern",
	"Vivid Sienna II",
	"Smoky Scarlet",
	"Light Ochre",
	"Vivid Amber II",
	"Vivid Sienna III",
	"Deep Crimson",
	"Rich Amber",
	"Pale Gold",
	"Bold Copper II",
	"Light Sienna II",
	"Cool Citrine",
	"Pale Citrine",
	"Light Copper",
	"Earthy Amber",
	"Rich Amber II",
	"Vivid Amber III",
	"Bold Gold",
	"Warm Ember II",
	"Moody Cobalt",
	"Vivid Sienna IV",
	"Warm Amber",
	"Bright Ochre II",
	"Warm Rust",
	"Light Sienna III",
	"Earthy Citrine",
	"Warm Ochre",
	"Vivid Ember",
	"Deep Scarlet",
	"Warm Crimson",
	"Soft Moss",
	"Earthy Ember",
	"Cool Violet",
	"Vivid Amber IV",
	"Soft Sage",
	"Warm Ember III",
	"Warm Amber II",
	"Light Ochre II",
	"Muted Teal",
	"Deep Sienna",
	"Cool Pine II",
	"Pale Sage",
	"Bold Ember",
	"Bright Amber",
	"Bold Amber III",
	"Earthy Crimson II",
	"Soft Sienna",
	"Bold Sage",
	"Light Amber",
	"Vivid Ember II",
	"Vivid Ochre",
	"Bold Rust",
	"Deep Teal",
	"Soft Moss II",
	"Warm Rust II",
	"Cool Moss II",
	"Earthy Rust",
	"Soft Gold",
	"Pale Sage II",
	"Warm Gold",
	"Smoky Pine",
	"Vivid Crimson",
	"Bold Ember II",
	"Light Sienna IV",
	"Warm Ochre II",
	"Light Rust II",
	"Bold Sage II",
	"Light Fern",
	"Rich Copper II",
	"Light Ember",
	"Dark Rose",
	"Bright Citrine",
	"Bold Rust II",
	"Soft Crimson",
	"Rich Ember II",
	"Bold Copper III",
	"Rich Sienna",
	"Bold Amber IV",
	"Cool Fern",
	"Soft Citrine II",
	"Vivid Ember III",
	"Muted Amber",
	"Rich Rust II",
	"Earthy Ember II",
	"Bold Copper IV",
	"Earthy Sienna",
	"Cool Fern II",
	"Vivid Amber V",
	"Rich Copper III",
	"Light Ochre III",
	"Vivid Sienna V",
	"Bright Rust II",
	"Vivid Rust II",
	"Warm Amber III",
	"Vivid Copper",
	"Vivid Scarlet",
	"Vivid Rust III",
	"Warm Copper",
	"Light Copper II",
	"Light Ochre IV",
	"Cool Sage",
	"Muted Plum",
	"Moody Cobalt II",
	"Warm Copper II",
	"Muted Citrine",
	"Bright Ember",
	"Bold Citrine",
	"Bright Citrine II",
	"Earthy Crimson III",
	"Earthy Ochre",
	"Vivid Ochre II",
	"Linen II",
	"Soft Sage II",
	"Bold Rust III",
	"Vivid Amber VI",
	"Earthy Copper II",
	"Warm Ochre III",
	"Bold Copper V",
	"Light Copper III",
	"Rich Ember III",
	"Vivid Amber VII",
	"Light Ochre V",
	"Cool Pine III",
	"Cool Citrine II",
	"Warm Rust III",
	"Bold Fern",
	"Linen III",
	"Soft Moss III",
	"Rich Citrine",
	"Deep Rose",
	"Bold Copper VI",
	"Earthy Gold",
	"Soft Citrine III",
	"Pale Rust",
	"Bright Sienna II",
	"Earthy Sienna II",
	"Vivid Rust IV",
	"Earthy Copper III",
	"Bold Sienna III",
	"Moody Teal II",
	"Rich Crimson",
	"Warm Copper III",
	"Vivid Sienna VI",
	"Bold Sienna IV",
	"Bold Ember III",
	"Vivid Rust V",
	"Deep Copper",
	"Deep Sienna II",
	"Warm Scarlet",
	"Earthy Rust II",
	"Cool Sage II",
	"Pale Ochre",
	"Vivid Ember IV",
	"Rich Amber III",
	"Rich Ochre",
	"Bold Sage III",
	"Warm Copper IV",
	"Warm Amber IV",
	"Warm Crimson II",
	"Vivid Copper II",
	"Rich Crimson II",
	"Bright Sienna III",
	"Earthy Gold II",
	"Soft Gold II",
	"Bright Copper",
	"Moody Cobalt III",
	"Rich Rust III",
	"Earthy Scarlet II",
	"Rich Crimson III",
	"Warm Gold II",
	"Warm Sienna",
	"Deep Crimson II",
	"Bold Rust IV",
	"Light Sage",
	"Pale Scarlet",
	"Light Gold",
	"Deep Fern II",
	"Bold Amber V",
	"Earthy Copper IV",
	"Warm Amber V",
	"Rich Sienna II",
	"Rich Copper IV",
	"Deep Scarlet II",
	"Warm Rust IV",
	"Bright Moss",
	"Moody Teal III",
	"Bold Rust V",
	"Bold Sienna V",
	"Cool Citrine III",
	"Light Ember II",
	"Bold Rust VI",
	"Rich Rust IV",
	"Muted Ochre",
	"Vivid Sienna VII",
	"Rich Sienna III",
	"Vivid Scarlet II",
	"Earthy Amber II",
	"Earthy Crimson IV",
	"Muted Indigo",
	"Vivid Rust VI",
	"Bold Rust VII",
	"Warm Sienna II",
	"Warm Sienna III",
	"Moody Sage",
	"Vivid Ember V",
	"Warm Amber VI",
	"Warm Rust V",
	"Warm Ochre IV",
	"Warm Ochre V",
	"Bone",
	"Vivid Indigo",
	"Warm Ember IV",
	"Deep Ember",
	"Vivid Citrine",
	"Rich Crimson IV",
	"Rich Citrine II",
	"Bright Ember II",
	"Earthy Ochre II",
	"Bright Ochre III",
	"Light Teal",
	"Deep Rose II",
	"Muted Plum II",
	"Warm Rust VI",
	"Light Ember III",
	"Warm Sienna IV",
	"Bold Ember IV",
	"Soft Fern",
	"Bright Sage",
	"Bold Sienna VI",
	"Vivid Sienna VIII",
	"Earthy Citrine II",
	"Rich Rust V",
	"Light Sienna V",
	"Bold Citrine II",
	"Warm Sienna V",
	"Warm Rust VII",
	"Light Sage II",
	"Rich Amber IV",
	"Rich Amber V",
	"Vivid Sienna IX",
	"Bold Amber VI",
	"Light Copper IV",
	"Earthy Ember III",
	"Soft Ember II",
	"Smoky Pine II",
	"Bold Sienna VII",
	"Cool Citrine IV",
	"Warm Ochre VI",
	"Vivid Rust VII",
	"Earthy Scarlet III",
	"Linen IV",
	"Warm Amber VII",
	"Bold Amber VII",
	"Vivid Crimson II",
	"Earthy Scarlet IV",
	"Warm Copper V",
	"Light Ember IV",
	"Rich Crimson V",
	"Light Moss",
	"Smoky Copper",
	"Light Sage III",
	"Vivid Rust VIII",
	"Vivid Sienna X",
	"Light Gold II",
	"Vivid Ochre III",
	"Bold Ochre III",
	"Bright Rust III",
	"Dark Violet",
	"Moody Citrine",
	"Vivid Copper III",
	"Vivid Sienna XI",
	"Warm Sienna VI",
	"Warm Copper VI",
	"Vivid Amber VIII",
	"Pale Citrine II",
	"Vivid Rose",
	"Vivid Ember VI",
	"Warm Gold III",
	"Bold Ember V",
	"Bold Sienna VIII",
	"Warm Sienna VII",
	"Deep Ember II",
	"Warm Amber VIII",
	"Linen V",
	"Pale Sienna",
	"Smoky Gold",
	"Bold Ochre IV",
	"Warm Crimson III",
	"Light Fern II",
	"Vivid Sienna XII",
	"Earthy Sienna III",
	"Deep Rose III",
	"Bright Rust IV",
	"Bold Crimson",
	"Earthy Crimson V",
	"Rich Ember IV",
	"Vivid Amber IX",
	"Light Moss II",
	"Cool Sage III",
	"Rich Pine",
	"Rich Scarlet",
	"Vivid Copper IV",
	"Bold Ochre V",
	"Warm Crimson IV",
	"Rich Fern",
	"Moody Fern",
	"Rich Copper V",
	"Bold Amber VIII",
	"Bone II",
	"Vivid Ember VII",
	"Bone III",
	"Bold Crimson II",
	"Light Amber II",
	"Warm Sienna VIII",
	"Vivid Copper V",
	"Rich Teal",
	"Moody Fern II",
	"Warm Sienna IX",
	"Bold Scarlet",
	"Deep Iris",
	"Earthy Ember IV",
	"Earthy Amber III",
	"Rich Ochre II",
	"Moody Plum",
	"Smoky Pine III",
	"Warm Amber IX",
	"Bold Sienna IX",
	"Soft Crimson II",
	"Bright Gold",
	"Warm Rust VIII",
	"Deep Iris II",
	"Bold Fern II",
	"Light Sienna VI",
	"Vivid Sienna XIII",
	"Bold Rust VIII",
	"Bold Amber IX",
	"Warm Rust IX",
	"Light Scarlet II",
	"Earthy Amber IV",
	"Bold Rust IX",
	"Earthy Crimson VI",
	"Bold Crimson III",
	"Warm Rust X",
	"Warm Sienna X",
	"Bright Copper II",
	"Rich Ember V",
	"Pale Azure",
	"Bright Citrine III",
	"Light Rust III",
	"Deep Scarlet III",
	"Vivid Ember VIII",
	"Bold Sienna X",
	"Pale Crimson",
	"Stone",
	"Light Ochre VI",
	"Pale Ochre II",
	"Bright Ochre IV",
	"Vivid Sienna XIV",
	"Soft Slate",
	"Linen VI",
	"Earthy Ochre III",
	"Pale Azure II",
	"Light Crimson",
	"Rich Crimson VI",
	"Bold Rust X",
	"Vivid Amber X",
	"Cool Sage IV",
	"Bone IV",
	"Earthy Scarlet V",
	"Cool Citrine V",
	"Bold Rust XI",
	"Rich Rose",
	"Warm Sienna XI",
	"Deep Crimson III",
	"Rich Sienna IV",
	"Rich Ochre III",
	"Bold Copper VII",
	"Bold Ember VI",
	"Rich Crimson VII",
	"Bold Gold II",
	"Bold Sienna XI",
	"Pale Sienna II",
	"Rich Amber VI",
	"Linen VII",
	"Warm Rose",
	"Soft Ochre",
	"Light Sienna VII",
	"Earthy Ochre IV",
	"Pale Fern",
	"Rich Copper VI",
	"Vivid Ember IX",
	"Moody Fern III",
	"Bold Amber X",
	"Vivid Sienna XV",
	"Pale Slate",
	"Deep Rose IV",
	"Light Sage IV",
	"Cool Teal",
	"Vivid Copper VI",
	"Muted Ochre II",
	"Bold Copper VIII",
	"Linen VIII",
	"Light Amber III",
	"Vivid Rust IX",
	"Rich Amber VII",
	"Earthy Ochre V",
	"Bold Sienna XII",
	"Warm Ember V",
	"Muted Plum III",
	"Light Fern III",
	"Rich Crimson VIII",
	"Deep Sienna III",
	"Earthy Scarlet VI",
	"Light Amber IV",
	"Bold Rust XII",
	"Smoky Seafoam",
	"Bold Amber XI",
	"Vivid Scarlet III",
	"Pale Amber",
	"Vivid Ochre IV",
	"Earthy Ember V",
	"Pale Rust II",
	"Moody Sage II",
	"Deep Ember III",
	"Light Sage V",
	"Soft Ember III",
	"Stone II",
	"Rich Sienna V",
	"Moody Citrine II",
	"Light Ochre VII",
	"Bold Gold III",
	"Warm Sienna XII",
	"Earthy Rose",
	"Pale Ember",
	"Vivid Rust X",
	"Vivid Iris",
	"Vivid Ember X",
	"Rich Sienna VI",
	"Rich Copper VII",
	"Deep Ember IV",
	"Warm Rust XI",
	"Pale Citrine III",
	"Moody Citrine III",
	"Warm Scarlet II",
	"Bone V",
	"Bright Amber II",
	"Rich Pine II",
	"Bold Ember VII",
	"Vivid Crimson III",
	"Light Pine",
	"Vivid Copper VII",
	"Vivid Copper VIII",
	"Warm Scarlet III",
	"Rich Rust VI",
	"Rich Scarlet II",
	"Earthy Copper V",
	"Vivid Sienna XVI",
	"Light Sage VI",
	"Pale Moss",
	"Bold Citrine III",
	"Deep Ember V",
	"Rich Scarlet III",
	"Light Amber V",
	"Soft Sage III",
	"Smoky Scarlet II",
	"Warm Ochre VII",
	"Rich Sienna VII",
	"Light Ember V",
	"Warm Rust XII",
	"Bold Ember VIII",
	"Muted Citrine II",
	"Vivid Rust XI",
	"Bright Copper III",
	"Bold Sage IV",
	"Cool Seafoam",
	"Rich Crimson IX",
	"Pale Iris",
	"Warm Ochre VIII",
	"Deep Scarlet IV",
	"Bold Crimson IV",
	"Warm Copper VII",
	"Vivid Amber XI",
	"Deep Violet",
	"Vivid Ochre V",
	"Rich Rust VII",
	"Rich Sienna VIII",
	"Warm Iris",
	"Warm Rust XIII",
	"Warm Crimson V",
	"Deep Rust",
	"Ash",
	"Warm Sienna XIII",
	"Vivid Scarlet IV",
	"Warm Scarlet IV",
	"Bold Copper IX",
	"Rich Ember VI",
	"Bold Scarlet II",
	"Light Ember VI",
	"Cool Fern III",
	"Deep Sienna IV",
	"Vivid Sienna XVII",
	"Smoky Moss",
	"Warm Copper VIII",
	"Linen IX",
	"Bold Copper X",
	"Bold Citrine IV",
	"Vivid Crimson IV",
	"Bold Sienna XIII",
	"Rich Scarlet IV",
	"Cool Citrine VI",
	"Ash II",
	"Light Fern IV",
	"Dark Ember",
	"Light Sage VII",
	"Bold Copper XI",
	"Rich Ember VII",
	"Muted Scarlet",
	"Bold Crimson V",
	"Vivid Teal",
	"Bold Ember IX",
	"Pale Gold II",
	"Pale Citrine IV",
	"Rich Sienna IX",
	"Stone III",
	"Warm Copper IX",
	"Bold Sienna XIV",
	"Bold Sienna XV",
	"Vivid Ember XI",
	"Light Teal II",
	"Light Seafoam",
	"Rich Sienna X",
	"Muted Gold II",
	"Cool Pine IV",
	"Deep Plum",
	"Warm Ochre IX",
	"Smoky Moss II",
	"Vivid Rust XII",
	"Bold Sienna XVI",
	"Vivid Amber XII",
	"Vivid Gold",
	"Soft Sienna II",
	"Warm Rust XIV",
	"Rich Sienna XI",
	"Deep Copper II",
	"Vivid Ember XII",
	"Cool Sage V",
	"Earthy Rust III",
	"Light Pine II",
	"Vivid Rose II",
	"Warm Ember VI",
	"Vivid Ember XIII",
	"Bold Rust XIII",
	"Soft Ember IV",
	"Rich Ember VIII",
	"Linen X",
	"Soft Moss IV",
	"Bold Amber XII",
	"Rich Amber VIII",
	"Bold Sienna XVII",
	"Vivid Rust XIII",
	"Vivid Sienna XVIII",
	"Bold Sienna XVIII",
	"Deep Ember VI",
	"Vivid Copper IX",
	"Bold Crimson VI",
	"Bold Amber XIII",
	"Bright Ochre V",
	"Vivid Rose III",
	"Vivid Amber XIII",
	"Muted Ember",
	"Warm Rust XV",
	"Vivid Ochre VI",
	"Rich Amber IX",
	"Rich Ochre IV",
	"Warm Sienna XIV",
	"Muted Cobalt",
	"Earthy Ember VI",
	"Cool Sage VI",
	"Vivid Rose IV",
	"Light Gold III",
	"Earthy Copper VI",
	"Vivid Rust XIV",
	"Warm Gold IV",
	"Light Sienna VIII",
	"Earthy Rose II",
	"Rich Ember IX",
	"Vivid Ember XIV",
	"Cool Sage VII",
	"Earthy Crimson VII",
	"Warm Crimson VI",
	"Bold Ember X",
	"Bright Ember III",
	"Cool Teal II",
	"Light Amber VI",
	"Rich Copper VIII",
	"Rich Copper IX",
	"Deep Copper III",
	"Bold Ochre VI",
	"Bold Sienna XIX",
	"Cool Dusk",
	"Light Fern V",
	"Warm Gold V",
	"Bone VI",
	"Dark Azure",
	"Light Sage VIII",
	"Vivid Copper X",
	"Cool Citrine VII",
	"Bold Copper XII",
	"Vivid Sienna XIX",
	"Vivid Amber XIV",
	"Light Citrine II",
	"Warm Rust XVI",
	"Light Fern VI",
	"Rich Scarlet V",
	"Linen XI",
	"Warm Ember VII",
	"Warm Copper X",
	"Bright Ochre VI",
	"Bright Sienna IV",
	"Earthy Scarlet VII",
	"Dark Violet II",
	"Vivid Gold II",
	"Warm Rust XVII",
	"Vivid Ember XV",
	"Earthy Amber V",
	"Light Amber VII",
	"Earthy Crimson VIII",
	"Linen XII",
	"Earthy Sienna IV",
	"Light Copper V",
	"Deep Scarlet V",
	"Ash III",
	"Earthy Scarlet VIII",
	"Rich Sienna XII",
	"Cool Citrine VIII",
	"Rich Rust VIII",
	"Deep Sage",
	"Warm Rust XVIII",
	"Pale Ember II",
	"Vivid Rust XV",
	"Warm Copper XI",
	"Bright Sage II",
	"Vivid Rust XVI",
	"Bold Copper XIII",
	"Bold Copper XIV",
	"Warm Ochre X",
	"Light Amber VIII",
	"Bold Ember XI",
	"Bright Sage III",
	"Bold Copper XV",
	"Light Sage IX",
	"Ash IV",
	"Deep Ember VII",
	"Soft Fern II",
	"Bright Amber III",
	"Vivid Amber XV",
	"Deep Fern III",
	"Bold Ember XII",
	"Light Sienna IX",
	"Warm Ember VIII",
	"Cool Teal III",
	"Light Gold IV",
	"Deep Copper IV",
	"Warm Ember IX",
	"Light Rust IV",
	"Rich Sienna XIII",
	"Rich Amber X",
	"Warm Amber X",
	"Warm Sienna XV",
	"Vivid Rust XVII",
	"Rich Rose II",
	"Bold Moss",
	"Warm Scarlet V",
	"Warm Sienna XVI",
	"Bold Rust XIV",
	"Bold Ember XIII",
	"Rich Moss",
	"Light Scarlet III",
	"Warm Copper XII",
	"Earthy Ember VII",
	"Light Citrine III",
	"Bold Rust XV",
	"Warm Scarlet VI",
	"Earthy Scarlet IX",
	"Light Ochre VIII",
	"Vivid Gold III",
	"Earthy Scarlet X",
	"Vivid Sienna XX",
	"Vivid Copper XI",
	"Vivid Sage II",
	"Vivid Copper XII",
	"Ash V",
	"Vivid Sienna XXI",
	"Rich Rust IX",
	"Bold Ember XIV",
	"Light Gold V",
	"Earthy Scarlet XI",
	"Bold Copper XVI",
	"Vivid Ember XVI",
	"Bright Ochre VII",
	"Bright Amber IV",
	"Vivid Rust XVIII",
	"Bone VII",
	"Light Citrine IV",
	"Rich Ochre V",
	"Bold Copper XVII",
	"Vivid Dusk",
	"Light Citrine V",
	"Vivid Scarlet V",
	"Pale Citrine V",
	"Muted Indigo II",
	"Bold Rust XVI",
	"Vivid Violet",
	"Deep Sienna V",
	"Bright Ochre VIII",
	"Rich Sienna XIV",
	"Rich Rust X",
	"Earthy Rose III",
	"Earthy Iris",
	"Dark Crimson",
	"Rich Scarlet VI",
	"Soft Ember V",
	"Warm Sienna XVII",
	"Warm Copper XIII",
	"Earthy Sienna V",
	"Earthy Gold III",
	"Warm Copper XIV",
	"Light Citrine VI",
	"Warm Plum",
	"Vivid Amber XVI",
	"Deep Copper V",
	"Linen XIII",
	"Warm Gold VI",
	"Bold Sage V",
	"Vivid Ochre VII",
	"Vivid Ochre VIII",
	"Rich Copper X",
	"Vivid Ochre IX",
	"Deep Cobalt",
	"Rich Sage",
	"Warm Rust XIX",
	"Pale Citrine VI",
	"Earthy Ember VIII",
	"Bright Ochre IX",
	"Dark Crimson II",
	"Deep Ember VIII",
	"Ash VI",
	"Soft Sienna III",
	"Bright Ochre X",
	"Warm Gold VII",
	"Bright Ochre XI",
	"Pale Rust III",
	"Warm Rust XX",
	"Warm Sienna XVIII",
	"Bright Ochre XII",
	"Bright Ochre XIII",
	"Warm Rust XXI",
	"Moody Fern IV",
	"Light Moss III",
	"Earthy Copper VII",
	"Warm Gold VIII",
	"Bone VIII",
	"Stone IV",
	"Deep Rose V",
	"Warm Rust XXII",
	"Bold Sage VI",
	"Rich Ember X",
	"Rich Crimson X",
	"Bold Ember XV",
	"Light Teal III",
	"Bright Sage IV",
	"Warm Rust XXIII",
	"Earthy Gold IV",
	"Deep Plum II",
	"Deep Violet II",
	"Rich Crimson XI",
	"Pale Sienna III",
	"Deep Scarlet VI",
	"Moody Fern V",
	"Rich Ochre VI",
	"Muted Citrine III",
	"Moody Cobalt IV",
	"Stone V",
	"Vivid Plum",
	"Rich Rust XI",
	"Warm Copper XV",
	"Light Sienna X",
	"Vivid Amber XVII",
	"Light Amber IX",
	"Cool Sage VIII",
	"Earthy Rust IV",
	"Vivid Copper XIII",
	"Soft Indigo",
	"Rich Crimson XII",
	"Bold Amber XIV",
	"Light Scarlet IV",
	"Muted Copper",
	"Vivid Violet II",
	"Rich Ember XI",
	"Bold Gold IV",
	"Earthy Amber VI",
	"Vivid Rust XIX",
	"Stone VI",
	"Warm Copper XVI",
	"Warm Amber XI",
	"Pale Sienna IV",
	"Vivid Ember XVII",
	"Earthy Ember IX",
	"Cool Sage IX",
	"Rich Copper XI",
	"Vivid Gold IV",
	"Cool Fern IV",
	"Bold Rust XVII",
	"Warm Copper XVII",
	"Light Sage X",
	"Rich Sienna XV",
	"Deep Crimson IV",
	"Earthy Rose IV",
	"Bold Sienna XX",
	"Bold Gold V",
	"Deep Plum III",
	"Bright Fern II",
	"Warm Sienna XIX",
	"Earthy Amber VII",
	"Cool Pine V",
	"Warm Ember X",
	"Bold Rust XVIII",
	"Earthy Rust V",
	"Light Sienna XI",
	"Bold Ember XVI",
	"Muted Teal II",
	"Earthy Copper VIII",
	"Bright Copper IV",
	"Light Ochre IX",
	"Vivid Fern",
	"Rich Ember XII",
	"Deep Gold",
	"Vivid Rust XX",
	"Rich Scarlet VII",
	"Warm Ochre XI",
	"Bold Rust XIX",
	"Light Sienna XII",
	"Light Gold VI",
	"Light Sage XI",
	"Vivid Copper XIV",
	"Rich Rose III",
	"Vivid Copper XV",
	"Earthy Copper IX",
	"Earthy Iris II",
	"Warm Amber XII",
	"Bold Ochre VII",
	"Vivid Rust XXI",
	"Vivid Ember XVIII",
	"Light Amber X",
	"Bold Copper XVIII",
	"Deep Ochre",
	"Vivid Scarlet VI",
	"Light Gold VII",
	"Cool Fern V",
	"Earthy Iris III",
	"Vivid Rust XXII",
	"Deep Copper VI",
	"Warm Ochre XII",
	"Warm Ochre XIII",
	"Deep Moss",
	"Muted Scarlet II",
	"Bold Rust XX",
	"Deep Rust II",
	"Warm Scarlet VII",
	"Dark Crimson III",
	"Pale Fern II",
	"Cool Citrine IX",
	"Bright Sienna V",
	"Muted Dusk",
	"Pale Copper",
	"Cool Violet II",
	"Deep Amber",
	"Warm Amber XIII",
	"Vivid Violet III",
	"Rich Copper XII",
	"Linen XIV",
	"Bold Sage VII",
	"Bold Sienna XXI",
	"Bright Gold II",
	"Muted Plum IV",
	"Warm Copper XVIII",
	"Soft Gold III",
	"Warm Copper XIX",
	"Bold Fern III",
	"Warm Iris II",
	"Bold Ember XVII",
	"Rich Ember XIII",
	"Bone IX",
	"Pale Ember III",
	"Rich Ochre VII",
	"Rich Ember XIV",
	"Bold Sienna XXII",
	"Bold Sienna XXIII",
	"Light Ochre X",
	"Light Copper VI",
	"Bold Ochre VIII",
	"Light Amber XI",
	"Earthy Ember X",
	"Warm Copper XX",
	"Vivid Rust XXIII",
	"Bright Gold III",
	"Bold Ember XVIII",
	"Light Copper VII",
	"Earthy Scarlet XII",
	"Stone VII",
	"Earthy Copper X",
	"Bold Gold VI",
	"Warm Amber XIV",
	"Warm Sienna XX",
	"Rich Moss II",
	"Rich Rust XII",
	"Bold Rust XXI",
	"Rich Rust XIII",
	"Earthy Scarlet XIII",
	"Vivid Copper XVI",
	"Vivid Sienna XXII",
	"Rich Scarlet VIII",
	"Bold Ochre IX",
	"Warm Rust XXIV",
	"Light Sage XII",
	"Warm Sienna XXI",
	"Bold Copper XIX",
	"Bold Copper XX",
	"Earthy Amber VIII",
	"Light Gold VIII",
	"Light Ember VII",
	"Vivid Ochre X",
	"Muted Fern",
	"Bold Amber XV",
	"Light Rust V",
	"Vivid Ember XIX",
	"Deep Copper VII",
	"Deep Cobalt II",
	"Rich Rust XIV",
	"Moody Sage III",
	"Rich Copper XIII",
	"Bright Sienna VI",
	"Light Scarlet V",
	"Light Sienna XIII",
	"Rich Rose IV",
	"Warm Copper XXI",
	"Vivid Rust XXIV",
	"Stone VIII",
	"Cool Slate",
	"Pale Sienna V",
	"Earthy Scarlet XIV",
	"Soft Sage IV",
	"Warm Ember XI",
	"Earthy Ochre VI",
	"Bold Amber XVI",
	"Warm Ember XII",
	"Light Rust VI",
	"Earthy Ember XI",
];

function setup() {
	// Create display canvas at landscape default; resized after orientation is determined.
	const { w, h } = canvasSize();
	createCanvas(w, h);
	frameRate(24);
	noLoop();

	// ─── ALL R() draws happen synchronously BEFORE fetch() ───────────────────
	// The fxhash sandbox sends "fxhash_getInfo" immediately on iframe load and
	// reads $fx.getFeatures() at that moment. Everything must be set before the
	// fetch resolves. The fetch callback only loads palette hex colors.
	// ─────────────────────────────────────────────────────────────────────────

	noiseSeed(Math.round(R() * 0xffffffff));

	// Palette index — pool size matches the PALETTE_NAMES / 1000.json array length.
	config.palette = Math.floor(R() * PALETTE_NAMES.length);

	// Rothko Mode: ~10% chance of a rare "stacked color fields" composition.
	// When active, draw() calls initRothkoScene() instead of initScene().
	config.isRothko = R() < 0.07;
	if (config.isRothko) {
		// Field count: weighted toward 2–3 but 4–5 possible for denser compositions.
		const fc = R();
		config.fieldCount = fc < 0.3 ? 2 : fc < 0.65 ? 3 : fc < 0.9 ? 4 : 5;
		config.rothkoOrientation = R() < 0.5 ? "horizontal" : "vertical";
		// Proportion mode: how fields divide the canvas.
		// Balanced — roughly equal weights (current behavior).
		// Dominant — one field takes 50–70%, others share the rest.
		// Staggered — alternating large/small fields.
		const pm = R();
		config.rothkoProportionMode =
			pm < 0.5 ? "balanced" : pm < 0.78 ? "dominant" : "staggered";
		if (config.rothkoProportionMode === "dominant") {
			// Pick which field is the dominant one.
			config.rothkoDominantIdx = Math.floor(R() * config.fieldCount);
		}
		// Always burn 1 R() for the potential palette reroll so the stream stays
		// consistent whether or not the reroll fires (decided in fetch after colors load).
		config._rerollRand = R();
	}

	// Canvas format: Rothko horizontal → portrait, vertical → landscape, normal → ~15% portrait.
	isPortrait = config.isRothko
		? config.rothkoOrientation === "horizontal"
		: R() < 0.15;
	config.isPortrait = isPortrait;

	// Off-screen buffer dimensions (swap W/H for portrait).
	config.width = isPortrait ? fullHeight : fullWidth;
	config.height = isPortrait ? fullWidth : fullHeight;
	pg = createGraphics(config.width, config.height);
	const { w: dw, h: dh } = canvasSize();
	resizeCanvas(dw, dh);

	config.cols = randomInt(R, 6, 22);
	config.rows = randomInt(R, 5, 14);
	config.cellwidth = config.width / config.cols;
	config.smears = randomInt(R, 2, 6);
	config.squareWaves = randomInt(R, 2, 4);
	config.grainAmt = 8 + R() * 14;
	config.grainSeed = Math.round(R() * 0xffffffff);
	config.chromaShift = floor(1 + R() * 4);
	config.hazeStrength = 0.12 + R() * 0.3;
	config.lightLeakCount = randomInt(R, 2, 6);
	config.lightLeakSeed = Math.round(R() * 0xffffffff);
	config.noiseSeed = Math.round(R() * 0xffffffff); // seed for p5 noise() — must be set via noiseSeed() before any noise() call

	if (config.isRothko) {
		// Edge style governs margins and gap character.
		// Float  — margins on all sides; fields hover in background.
		// Bleed  — no margins; fields run edge-to-edge; only gap shows background.
		// Frame  — exaggerated margins; background becomes a bold compositional element.
		const es = R();
		config.rothkoEdgeStyle = es < 0.5 ? "float" : es < 0.85 ? "bleed" : "frame";
		if (config.rothkoEdgeStyle === "bleed") {
			config.fieldMargin = 0;
			config.fieldGap = Math.round(config.height * (0.008 + R() * 0.025));
		} else if (config.rothkoEdgeStyle === "frame") {
			config.fieldMargin = Math.round(config.width * (0.06 + R() * 0.06));
			config.fieldGap = Math.round(config.height * (0.005 + R() * 0.015));
		} else {
			// float (original behavior)
			config.fieldMargin = Math.round(config.width * (0.02 + R() * 0.02));
			config.fieldGap = Math.round(config.height * (0.01 + R() * 0.02));
		}
	}
	config.captureCells = randomInt(R, 5, 10);
	config.pixelationLevels = [
		randomInt(R, 2, 4),
		randomInt(R, 5, 10),
		randomInt(R, 12, 20),
	];

	config.newFills = R() < 0.15;

	// Build cell grid — layout only, no palette colors needed.
	const GAP = 0;
	const rawH = Array.from({ length: config.rows }, () => 0.3 + R() * 1.7);
	const totalRaw = rawH.reduce((a, b) => a + b, 0);
	rowHeights = rawH.map((rh) =>
		Math.max(3, Math.round((rh / totalRaw) * config.height)),
	);
	const hDrift = config.height - rowHeights.reduce((a, b) => a + b, 0);
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
		const rowNorm = y / config.rows;
		const hProb = rowNorm < 0.4 ? 0.85 : rowNorm < 0.7 ? 0.6 : 0.35;
		const dir = R() < hProb ? "h" : "v";
		const mode = MODES[randomInt(R, 0, MODES.length - 1)];
		dir === "h" ? hCount++ : vCount++;

		const isRestZone =
			(rowNorm < 0.45 && R() < 0.4) || (rowNorm > 0.75 && R() < 0.3);
		const restDivisor = isRestZone ? randomInt(R, 2, 4) : 1;
		const rowCols = Math.max(2, Math.floor(config.cols / restDivisor));
		const rowCellW = config.width / rowCols;
		const rowOffset = y % 2 === 1 ? rowCellW * 0.5 : 0;
		const numCols = y % 2 === 1 ? rowCols + 1 : rowCols;

		for (let x = 0; x < numCols; x++) {
			const xStart = Math.round(x * rowCellW - rowOffset);
			const xEnd = Math.round((x + 1) * rowCellW - rowOffset);
			cells.push({
				x: xStart,
				y: yPos,
				w: xEnd - xStart,
				h: cellH,
				dir,
				mode,
			});
		}
		yPos += rowHeights[y];
	}

	// Animation seed — burned last so it does not shift any prior R() calls.
	// Seeded per-strip directions and speeds are deterministic per token.
	config.animSeed = Math.round(R() * 0xffffffff);

	// Compute features from the synchronously-built config.
	const totalCells = config.cols * config.rows;
	const density =
		totalCells < 60 ? "Sparse" : totalCells < 160 ? "Medium" : "Dense";
	const flowRatio = hCount / config.rows;
	const flow =
		flowRatio > 0.7 ? "Horizontal" : flowRatio < 0.3 ? "Vertical" : "Mixed";
	const clarity =
		config.chromaShift <= 1
			? "Sharp"
			: config.chromaShift <= 3
				? "Soft"
				: "Dreamy";
	const grain =
		config.grainAmt < 12 ? "Still" : config.grainAmt < 18 ? "Dusted" : "Worn";

	// Called synchronously — sandbox reads this immediately on fxhash_getInfo.
	$fx.features({
		Pallet: PALETTE_NAMES[config.palette],
		Tesserae: density,
		Current: flow,
		Refraction: clarity,
		Composition: config.isRothko
			? config.rothkoOrientation === "vertical"
				? "Vertical Fields"
				: "Horizontal Fields"
			: "Mosaic",
		Format: config.isPortrait ? "Portrait" : "Landscape",
		...(config.isRothko
			? {
					Ground:
						config.rothkoEdgeStyle.charAt(0).toUpperCase() +
						config.rothkoEdgeStyle.slice(1),
					Proportion:
						config.rothkoProportionMode.charAt(0).toUpperCase() +
						config.rothkoProportionMode.slice(1),
				}
			: { Grain: grain }),
	});

	// ─── Fetch palette hex colors — the only async dependency ────────────────
	fetch("1000.json")
		.then((res) => res.json())
		.then((data) => {
			palettes = data;
			palette = [...palettes[config.palette]];
			palette.push(suggestColor(palette));
			palette.push(suggestColor(palette));
			palette.sort((a, b) => chroma(a).luminance() - chroma(b).luminance());
			config.bgColor = palette[0];

			// Palette contrast reroll — uses the pre-burned _rerollRand value.
			// config.palette (and the palette feature) reflects the original draw;
			// this only affects rendered colors for ~2% of Rothko tokens.
			if (config.isRothko && paletteDeltaE(palette) < 20) {
				const rerollIdx = Math.floor(config._rerollRand * palettes.length);
				palette = [...palettes[rerollIdx]];
				palette.push(suggestColor(palette));
				palette.push(suggestColor(palette));
				palette.sort((a, b) => chroma(a).luminance() - chroma(b).luminance());
				config.bgColor = palette[0];
			}

			console.log(
				"seed:",
				_seedParam ?? $fx.hash,
				"features:",
				$fx.getFeatures(),
			);
			redraw();
		})
		.catch((err) => {
			console.error("Palette load failed:", err);
			// Call $fx.preview() directly — palette is still null so going through
			// draw() would just return early. This ensures fxsnapshot doesn't time
			// out waiting for the fxhash-preview event.
			$fx.preview();
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
 * Applies film grain to a graphics buffer.
 * Adds deterministic per-pixel luminance noise using a seeded RNG.
 * @param {p5.Graphics} source
 * @param {number} grainAmt - max per-channel noise in 0–255 range
 * @param {number} grainSeed - integer seed for the grain RNG (deterministic)
 */
function applyPostProcess(source, grainAmt, grainSeed) {
	source.loadPixels();
	const w = source.width,
		h = source.height;
	const pix = source.pixels;
	const grain = createRng(grainSeed);

	for (let y = 0; y < h; y++) {
		for (let x = 0; x < w; x++) {
			const noise = (grain() - 0.5) * 2 * grainAmt;
			const idx = (y * w + x) << 2;
			pix[idx] = Math.min(255, Math.max(0, (pix[idx] + noise) | 0));
			pix[idx + 1] = Math.min(255, Math.max(0, (pix[idx + 1] + noise) | 0));
			pix[idx + 2] = Math.min(255, Math.max(0, (pix[idx + 2] + noise) | 0));
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
function drawSquareWave(
	graphics,
	cellList,
	pal,
	waveIndex = 0,
	noiseSeedVal = 0,
) {
	// Seed p5's Perlin noise from the token's deterministic seed so renders are
	// reproducible. Without this, noise() uses a random internal seed each load.
	noiseSeed(noiseSeedVal);
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

function applyCells(graphics, palette, cells) {
	let newPalette = [...palette];
	let cc = 0;
	for (let i = 0; i < cells.length; i++) {
		let cell = cells[i];

		// Bias palette index by vertical position: top → lighter, bottom → darker.
		// palette is sorted dark[0] → light[last], so invert yNorm.
		const yNorm = cell.y / graphics.height;
		const yBias = floor((1 - yNorm) * newPalette.length * 0.75);
		const biasedCc = (cc + yBias) % newPalette.length;

		let fc = newPalette[biasedCc % newPalette.length];
		let nc = newPalette[(biasedCc + 1) % newPalette.length];

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

		if (i % newPalette.length === newPalette.length - 1) {
			// Consume the same RNG calls for compatibility, then re-sort by luminance
			// so the vertical position bias always indexes light→dark correctly.
			[...newPalette].sort(() => R() - 0.5);
			newPalette = [...palette]; // reset to luminance-sorted original
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

function applySquareWave(graphics, cells, palette, waves, noiseSeedVal = 0) {
	for (let i = 0; i < waves; i++) {
		drawSquareWave(graphics, cells, palette, i, noiseSeedVal);
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

	// Compute each rect's start and width from floor(index * span / level) so that
	// adjacent rects share exact integer pixel boundaries — no float accumulation drift
	// that would leave sub-pixel hairline gaps between tiles.
	for (let ix = 0; ix < level; ix++) {
		const px = Math.floor((ix * w) / level);
		const pw = Math.floor(((ix + 1) * w) / level) - px;
		if (pw <= 0) continue;
		for (let iy = 0; iy < level; iy++) {
			const py = Math.floor((iy * h) / level);
			const ph = Math.floor(((iy + 1) * h) / level) - py;
			if (ph <= 0) continue;
			const gp = source.get(px, py);
			graphics.fill(gp);
			graphics.noStroke();
			graphics.rect(x + px, y + py, pw, ph);
		}
	}
}

// initate the scene by applying all effects in order
function initScene(graphics, config, palette, cells) {
	graphics.background(config.bgColor || "#111");
	graphics.noStroke();

	// Core cell structure with gradient fills
	applyCells(graphics, palette, cells);

	// capture cells for later
	const newCells = shuffleR(cells)
		.sort((a, b) => b.w * b.h - a.w * a.h)
		.slice(0, config.captureCells);
	const capture = captureCells(graphics, newCells);

	const newCellsPlain = shuffleR(cells).slice(0, config.captureCells);

	const capturePlain = captureCells(graphics, newCellsPlain);

	// Atmospheric haze — sky wash on the upper portion
	applyAtmosphere(graphics, palette, config.hazeStrength);

	// Smear effect — biased horizontal in upper half (clouds), random in lower half (terrain)
	applySmear(graphics, config.smears);

	// Square wave effect
	applySquareWave(
		graphics,
		cells,
		palette,
		config.squareWaves,
		config.noiseSeed,
	);

	// apply back some of the captured cells without pixelation or square wave for contrast
	for (let i = 0; i < capturePlain.length; i++) {
		graphics.image(capturePlain[i], newCellsPlain[i].x, newCellsPlain[i].y);
	}

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
}

/**
 * Renders the Rothko Mode composition — 2–3 stacked color fields with
 * gradient-cell texture and soft painterly edges.
 *
 * Called instead of initScene() when config.isRothko is true.
 * Reuses applyCells, drawSmear, and the full post-processing stack.
 *
 * Pipeline per field:
 *   1. Build a mini cell grid constrained to the field's zone bounds.
 *   2. applyCells fills the zone with gradient-cell texture using the
 *      field's hue-clustered sub-palette.
 *   3. drawSmear (called directly, NOT applySmear) softens the field's
 *      boundary edges. Smear direction is axis-dependent:
 *        - Horizontal bands: north/south (d=1/3) blur top & bottom edges
 *        - Vertical bands:   east/west  (d=2/4) blur left & right edges
 *
 * After all fields, the shared post-processing stack runs once on the
 * full buffer (atmosphere, light leaks, grain, chromatic aberration).
 *
 * @param {p5.Graphics} graphics
 * @param {object} cfg - config object (must have isRothko, fieldCount,
 *                       fieldGap, fieldMargin, rothkoOrientation, and all
 *                       standard post-processing keys)
 * @param {string[]} pal - Palette sorted darkest→lightest
 */
function initRothkoScene(graphics, cfg, pal) {
	graphics.background(cfg.bgColor || "#111");
	graphics.noStroke();

	const isVertical = cfg.rothkoOrientation === "vertical";
	const zones = buildRothkoZones(cfg); // bounding rect per field
	// Exclude palette[0] (bgColor — the darkest color) from field palettes so no
	// field can be rendered in the background color and disappear.
	const clusters = clusterByHue(pal.slice(1), zones.length); // one sub-palette per field
	const MODES = ["lab", "lch", "hsl"];

	for (let zi = 0; zi < zones.length; zi++) {
		const zone = zones[zi];
		const fieldPal = clusters[zi]; // hue-distinct colors for this field

		// --- Build mini cell grid constrained to zone bounds ---
		// Wider ranges give each field independent textural character.
		const cols = randomInt(R, 4, 22);
		const rows = randomInt(R, 2, 9);
		// Ceiling ensures cellW is an integer — avoids hairline gaps caused by
		// fractional cellW leaving sub-pixel holes between adjacent cells.
		const cellW = Math.ceil(zone.width / cols);

		// Variable row heights — same weighted normalization as normal mode
		const rawH = Array.from({ length: rows }, () => 0.6 + R() * 0.8);
		const totalRaw = rawH.reduce((a, b) => a + b, 0);
		const rowHeights = rawH.map((h) =>
			Math.max(2, Math.round((h / totalRaw) * zone.height)),
		);
		// Correct rounding drift so rows fill the zone height exactly
		const hDrift = zone.height - rowHeights.reduce((a, b) => a + b, 0);
		rowHeights[rowHeights.length - 1] = Math.max(
			2,
			rowHeights[rowHeights.length - 1] + hDrift,
		);

		const fieldCells = [];
		let yPos = zone.y;
		for (let row = 0; row < rows; row++) {
			const cellH = rowHeights[row];
			// Brick offset on odd rows — rounded to integer so x positions stay pixel-aligned.
			const offset = row % 2 === 1 ? Math.round(cellW / 2) : 0;
			const numCols = row % 2 === 1 ? cols + 1 : cols; // extra cell covers brick gap
			const dir = R() < 0.5 ? "h" : "v"; // horizontal or vertical gradient direction
			const mode = MODES[randomInt(R, 0, MODES.length - 1)]; // color mix mode
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

		// Fill the zone with gradient-cell texture using the field's sub-palette
		applyCells(graphics, fieldPal, fieldCells);

		// capture cells for later
		const newFieldCells = shuffleR(fieldCells)
			.sort((a, b) => b.w * b.h - a.w * a.h)
			.slice(0, config.captureCells);
		const capture = captureCells(graphics, newFieldCells);

		const newFieldCellsPlain = shuffleR(fieldCells).slice(
			0,
			config.captureCells,
		);

		const capturePlain = captureCells(graphics, newFieldCellsPlain);

		// Square wave effect
		applySquareWave(
			graphics,
			fieldCells,
			fieldPal,
			config.squareWaves,
			config.noiseSeed,
		);

		// --- Smear at field boundary edges for a soft painterly look ---
		// We call drawSmear directly (not applySmear) because applySmear uses
		// config.width/height as its coordinate space — we need zone-relative coords.
		// d=1 north, d=2 east, d=3 south, d=4 west (see drawSmear).
		// Per-field smear intensity: 1 = smooth/minimal, 8 = heavily worked edges.
		const smearCount = randomInt(R, 1, 8);
		for (let s = 0; s < smearCount; s++) {
			const sw = zone.width * (0.1 + R() * 0.3);
			const sh = Math.max(4, zone.height * (0.05 + R() * 0.1));

			if (isVertical) {
				// Vertical bands: smear east/west to soften left and right edges
				const sy = zone.y + R() * zone.height;
				const d = R() < 0.5 ? 2 : 4; // east or west
				drawSmear(graphics, zone.x + R() * zone.width * 0.1, sy, sw, sh, d); // left edge
				drawSmear(
					graphics,
					zone.x + zone.width * (0.9 + R() * 0.1),
					sy,
					sw,
					sh,
					d,
				); // right edge
			} else {
				// Horizontal bands: smear north/south to soften top and bottom edges
				const sx = zone.x + R() * zone.width;
				const d = R() < 0.5 ? 1 : 3; // north or south
				drawSmear(graphics, sx, zone.y + R() * zone.height * 0.1, sw, sh, d); // top edge
				drawSmear(
					graphics,
					sx,
					zone.y + zone.height * (0.9 + R() * 0.1),
					sw,
					sh,
					d,
				); // bottom edge
			}
		}

		// use plain captured cells
		for (let i = 0; i < capturePlain.length; i++) {
			graphics.image(
				capturePlain[i],
				newFieldCellsPlain[i].x,
				newFieldCellsPlain[i].y,
			);
		}

		//use the captured cells
		for (let i = 0; i < capture.length; i++) {
			drawPixelation(
				graphics,
				capture[i],
				newFieldCells[i].x,
				newFieldCells[i].y,
				randomInt(R, ...config.pixelationLevels),
			);
		}
	}
	// Expose zones to animation system — initStrips() reads this to capture per-zone strips.
	rothkoZones = zones;
}

function postProcessing(graphics, cfg, pal) {
	// --- Shared post-processing — same as normal mode, applied once to full buffer ---
	// applyAtmosphere washes only the top ~45% of the canvas (hardcoded in its implementation)
	// so it naturally affects the topmost field without touching lower fields.
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

/**
 * Captures per-strip images from pg and seeds per-strip direction/speed.
 * Called once on first spacebar press, guarded by stripsReady.
 * Mosaic: one strip per rowHeights entry (follows the cell grid layout).
 * Rothko: equal-height strips using the same count as rowHeights — the mosaic grid
 * heights are uneven and can leave large unbroken sections on Rothko renders.
 */
function initStrips() {
	if (stripsReady) return;

	animatedPg = createGraphics(pg.width, pg.height);
	const animRng = createRng(config.animSeed);
	const count = rowHeights.length;

	// Generate directions from seeded RNG.
	for (let i = 0; i < count; i++) {
		rowDirections[i] = animRng() < 0.5 ? -1 : 1;
	}
	// Generate speeds, sort ascending so top strip is slowest, bottom fastest (parallax).
	const speeds = Array.from({ length: count }, () => 0.5 + animRng() * 3.5);
	speeds.sort((a, b) => a - b);

	if (config.isRothko) {
		// Equal-height strips — avoids one oversized mosaic row dominating the Rothko render.
		const stripH = Math.floor(pg.height / count);
		for (let i = 0; i < count; i++) {
			const yPos = i * stripH;
			const h = i === count - 1 ? pg.height - yPos : stripH;
			rowStrips[i] = pg.get(0, yPos, pg.width, h);
			rowDrawHeights[i] = h;
			rowSpeeds[i] = speeds[i];
			rowOffsets[i] = 0;
		}
	} else {
		let yPos = 0;
		for (let i = 0; i < count; i++) {
			rowStrips[i] = pg.get(0, yPos, pg.width, rowHeights[i]);
			rowDrawHeights[i] = rowHeights[i];
			rowSpeeds[i] = speeds[i];
			rowOffsets[i] = 0;
			yPos += rowHeights[i];
		}
	}

	stripsReady = true;
}

function draw() {
	if (!palette) return;

	// Render to pg once — subsequent calls (animation frames) only update the viewport.
	if (!pgReady) {
		background(config.bgColor || "#111");
		// Branch between Rothko Mode (~10% of tokens) and the standard mosaic composition.
		// initRothkoScene does not need the pre-built cells array — it builds its own per zone.
		config.isRothko
			? initRothkoScene(pg, config, palette)
			: initScene(pg, config, palette, cells);

		// apply post prossing effects (atmosphere, light leaks, grain, chromatic aberration)
		postProcessing(pg, config, palette);

		pgReady = true;
		$fx.preview();
		noLoop();
	}

	if (!animating) {
		// Show frozen animation frame when paused; static pg before animation has started or after reset.
		image(stripsReady ? animatedPg : pg, 0, 0, width, height);
		return;
	}

	// Animation frame — composite scrolling strips onto animatedPg.
	// config.bgColor is always set by the time animation runs (palette load completes before pgReady).
	animatedPg.background(config.bgColor);

	let yPos = 0;
	for (let i = 0; i < rowStrips.length; i++) {
		const sw = rowStrips[i].width;
		const offset = ((rowOffsets[i] % sw) + sw) % sw;
		animatedPg.image(rowStrips[i], offset, yPos);
		animatedPg.image(rowStrips[i], offset - sw, yPos);
		rowOffsets[i] += rowSpeeds[i] * rowDirections[i];
		yPos += rowDrawHeights[i];
	}

	image(animatedPg, 0, 0, width, height);
}

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
	if (key === "r" || key === "R") {
		if (!pgReady) return;
		// Reset animation — clears strips and returns to static pg view.
		animating = false;
		stripsReady = false;
		rowStrips = [];
		rowOffsets = [];
		rowDirections = [];
		rowSpeeds = [];
		rowDrawHeights = [];
		if (animatedPg) {
			animatedPg.remove();
			animatedPg = null;
		}
		noLoop();
		redraw();
	}
}

function windowResized() {
	const { w, h } = canvasSize();
	resizeCanvas(w, h);
	redraw();
}
