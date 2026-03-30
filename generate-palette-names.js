// generate-palette-names.js
// One-time script — run with:  node generate-palette-names.js
// Produces: palette-names.json — a name array embedded in sketch.js as PALETTE_NAMES.

const palettes = require('./1000.json');
const fs = require('fs');

// ─── Color math (no dependencies) ─────────────────────────────────────────────

function hexToLch(hex) {
    const r = parseInt(hex.slice(1, 3), 16) / 255;
    const g = parseInt(hex.slice(3, 5), 16) / 255;
    const b = parseInt(hex.slice(5, 7), 16) / 255;
    const lin = c => c > 0.04045 ? Math.pow((c + 0.055) / 1.055, 2.4) : c / 12.92;
    const R = lin(r), G = lin(g), B = lin(b);
    const X = R * 0.4124564 + G * 0.3575761 + B * 0.1804375;
    const Y = R * 0.2126729 + G * 0.7151522 + B * 0.0721750;
    const Z = R * 0.0193339 + G * 0.1191920 + B * 0.9503041;
    const f = t => t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116;
    const L = 116 * f(Y) - 16;
    const a = 500 * (f(X / 0.95047) - f(Y));
    const bv = 200 * (f(Y) - f(Z / 1.08883));
    const C = Math.sqrt(a * a + bv * bv);
    let H = Math.atan2(bv, a) * 180 / Math.PI;
    if (H < 0) H += 360;
    return [L, C, H];
}

function paletteLch(colors) {
    const lchs = colors.map(hexToLch);
    const avgL = lchs.reduce((s, [l]) => s + l, 0) / lchs.length;
    const avgC = lchs.reduce((s, [, c]) => s + c, 0) / lchs.length;
    // Circular mean hue, weighted by chroma (so near-neutrals don't shift it)
    let sx = 0, sy = 0;
    lchs.forEach(([, c, h]) => {
        const rad = h * Math.PI / 180;
        sx += Math.cos(rad) * c;
        sy += Math.sin(rad) * c;
    });
    let avgH = Math.atan2(sy, sx) * 180 / Math.PI;
    if (avgH < 0) avgH += 360;
    return { avgL, avgC, avgH };
}

// ─── Hue nouns — 27 bands, warm side split finely to spread the larger clusters ─

const HUE_BANDS = [
    [0,   16,  'Crimson'],
    [16,  30,  'Scarlet'],
    [30,  42,  'Ember'],
    [42,  52,  'Rust'],
    [52,  62,  'Copper'],
    [62,  72,  'Sienna'],
    [72,  82,  'Amber'],
    [82,  94,  'Ochre'],
    [94,  108, 'Gold'],
    [108, 122, 'Citrine'],
    [122, 138, 'Sage'],
    [138, 154, 'Fern'],
    [154, 170, 'Moss'],
    [170, 186, 'Pine'],
    [186, 204, 'Teal'],
    [204, 220, 'Seafoam'],
    [220, 236, 'Slate'],
    [236, 252, 'Azure'],
    [252, 266, 'Cobalt'],
    [266, 280, 'Indigo'],
    [280, 296, 'Dusk'],
    [296, 312, 'Violet'],
    [312, 328, 'Plum'],
    [328, 342, 'Iris'],
    [342, 360, 'Rose'],
];

// Neutral nouns by descending lightness
const NEUTRAL_NAMES = [
    [80, 'Bone'],
    [66, 'Linen'],
    [50, 'Stone'],
    [32, 'Ash'],
    [0,  'Charcoal'],
];

function getHueNoun(h) {
    for (const [lo, hi, noun] of HUE_BANDS) {
        if (h >= lo && h < hi) return noun;
    }
    return 'Crimson';
}

function getNeutralNoun(L) {
    for (const [threshold, noun] of NEUTRAL_NAMES) {
        if (L >= threshold) return noun;
    }
    return 'Charcoal';
}

// ─── Descriptor — always assigned (no bare noun except neutrals) ──────────────
//
// Grid:         C < 18      C 18–35      C 36–50      C > 50
//  L > 72      Pale         Light        Bright       Vivid
//  L 58–72     Soft         Warm/Cool*   Bold         Vivid
//  L 44–58     Muted        Earthy/Moody† Rich         Vivid
//  L 30–44     Smoky        Deep         Deep         Vivid
//  L < 30      Shadow       Dark         Dark         Dark
//
// * Warm hues (H < 110 or H > 320) → "Warm"; cool hues → "Cool"
// † Warm hues → "Earthy"; cool hues → "Moody"

function getDescriptor(L, C, H) {
    const isWarm = H < 110 || H > 320;
    if (C > 50)  return 'Vivid';
    if (L > 72)  return C > 35 ? 'Bright' : C > 18 ? 'Light' : 'Pale';
    if (L > 58)  return C > 35 ? 'Bold'   : C > 18 ? (isWarm ? 'Warm'   : 'Cool')  : 'Soft';
    if (L > 44)  return C > 35 ? 'Rich'   : C > 18 ? (isWarm ? 'Earthy' : 'Moody') : 'Muted';
    if (L > 30)  return C > 18 ? 'Deep'   : 'Smoky';
    return C > 20 ? 'Dark' : 'Shadow';
}

function namePalette({ avgL, avgC, avgH }) {
    if (avgC < 12) return getNeutralNoun(avgL);
    const noun = getHueNoun(avgH);
    const descriptor = getDescriptor(avgL, avgC, avgH);
    return `${descriptor} ${noun}`;
}

// ─── Generate and disambiguate ─────────────────────────────────────────────────

const ROMAN = [
    '', ' II', ' III', ' IV', ' V', ' VI', ' VII', ' VIII', ' IX', ' X',
    ' XI', ' XII', ' XIII', ' XIV', ' XV', ' XVI', ' XVII', ' XVIII', ' XIX', ' XX',
    ' XXI', ' XXII', ' XXIII', ' XXIV', ' XXV', ' XXVI', ' XXVII', ' XXVIII', ' XXIX', ' XXX',
];

const rawNames = palettes.map(p => namePalette(paletteLch(p)));

const totals = {};
rawNames.forEach(n => { totals[n] = (totals[n] || 0) + 1; });

const counters = {};
const names = rawNames.map(name => {
    if (totals[name] === 1) return name;
    counters[name] = (counters[name] || 0) + 1;
    const suffix = ROMAN[counters[name] - 1] ?? ` ${counters[name]}`;
    return name + suffix;
});

// ─── Write output ──────────────────────────────────────────────────────────────

fs.writeFileSync('./palette-names.json', JSON.stringify(names, null, 2));

const dupeGroups = Object.entries(totals)
    .filter(([, c]) => c > 1)
    .sort((a, b) => b[1] - a[1]);

console.log(`✓ Generated ${names.length} palette names → palette-names.json`);
console.log('\nSample (indices 0–9):');
names.slice(0, 10).forEach((n, i) => console.log(`  ${i}: ${n}`));
console.log(`\nUnique base names: ${Object.keys(totals).length}`);
console.log(`Base names with duplicates: ${dupeGroups.length}`);
console.log(`Worst case (most duplicates): ${dupeGroups[0]?.[0]} × ${dupeGroups[0]?.[1]}`);
console.log('\nTop 20 most-repeated base names:');
dupeGroups.slice(0, 20).forEach(([n, c]) => console.log(`  ${String(c).padStart(3)}×  ${n}`));
