# Tessera

Tessera is a study of color and its interactions. Each token is a unique arrangement of color fragments; gradient-filled tesserae laid in shifting rows, blending light and pigment across a curated palette.

Rare tokens resolve into something quieter: broad stacked fields inspired by Rothko paintings, where the fragments dissolve into the field.

## UI

Click anywhere to zoom in 3× to that point; click again to zoom out.

Press "s" to save the current token as an image.

## Build

The palette names embedded in `sketch.js` are generated from `1000.json`. To regenerate after editing palettes or the naming vocabulary:

```bash
node generate-palette-names.js
```

This writes `palette-names.json`. Then copy the printed output or run:

```bash
node -e "
const fs = require('fs');
const names = require('./palette-names.json');
const sketch = fs.readFileSync('./sketch.js', 'utf8');
const updated = sketch.replace(
    /const PALETTE_NAMES = \[.*?\];/s,
    'const PALETTE_NAMES = ' + JSON.stringify(names) + ';'
);
fs.writeFileSync('./sketch.js', updated);
console.log('PALETTE_NAMES updated in sketch.js');
"
```

## Features

- **Pallet** — one of ~1000 curated palettes, named by color family
- **Composition** — Mosaic (90%) or Horizontal/Vertical Fields (~10%, Rothko Mode)
- **Format** — Landscape or Portrait
- **Tesserae** — fragment count: Sparse, Medium, or Dense
- **Current** — gradient direction: Horizontal, Mixed, or Vertical
- **Refraction** — chromatic fringe: Sharp, Soft, or Dreamy
- **Ground** *(Rothko)* — field edge treatment: Float, Bleed, or Frame
- **Proportion** *(Rothko)* — band sizing: Balanced, Dominant, or Staggered

## Tools Used

- p5.js
- chroma.js
- fxhash.js
