# Row Animation Design

## Goal

Add a togglable scrolling animation to Tessera. The static `pg` render is preserved; a second `animatedPg` buffer composites horizontally scrolling row strips each frame. Spacebar starts and stops the animation. `s` downloads the static render; `a` downloads the current animated frame.

## Architecture

- `pg` — existing 4K off-screen buffer; rendered once; never modified by animation
- `animatedPg` — new p5.Graphics, same dimensions as `pg`; recomposited every animation frame
- Strips sliced from `pg` once at animation init; scrolled and wrapped each frame on `animatedPg`
- Mosaic and Rothko modes use different strip geometries (row heights vs zone bounds)

## Data Model

New globals added alongside `pg`:

| Global | Type | Description |
|--------|------|-------------|
| `animatedPg` | p5.Graphics | Composited animation buffer, same size as `pg` |
| `rowStrips` | p5.Image[] | One image per strip, captured from `pg` at init |
| `rowOffsets` | number[] | Current x-offset per strip in pg-space pixels |
| `rowDirections` | number[] | +1 or -1 per strip — seeded, deterministic per token |
| `rowSpeeds` | number[] | Pixels/frame per strip — seeded, range ~0.5–4 at 4K |
| `rowHeights` | number[] | Promoted from local in setup() to module-level; used in Mosaic path only |
| `rothkoZones` | object[] | Populated in initRothkoScene(); schema: `{ x, y, width, height }`; used in Rothko path only |
| `animating` | boolean | Animation running state; toggled by spacebar |
| `stripsReady` | boolean | Guards one-time strip capture |

### `config.animSeed`

New config value burned from `R()` in `setup()`. Must be added **after every other `R()` call in setup()** — including the Rothko block, `rowHeights` derivation, cell grid construction, and all existing named seeds (`noiseSeed`, `grainSeed`, `lightLeakSeed`, `_rerollRand`). Inserting it before any existing call would shift downstream seeds and break determinism for the static render.

Used to seed `createRng(config.animSeed)` for per-token directions and speeds.

## Strip Geometry

### Mosaic mode

- `rowHeights` promoted to module-level global (currently local to setup())
- Row Y positions derived as cumulative sum of `rowHeights`
- Each strip: `pg.get(0, rowY, pg.width, rowH)`
- Strip width = `pg.width` (full canvas width)
- Strip width is always exactly `pg.width` (the 4K buffer width), so the two-copy draw approach fully covers the strip with no gap and no clipping needed
- Strips composite at `destX=0, destY=rowY` on `animatedPg`

### Rothko mode

- `rothkoZones` stored as module-level global, populated at the end of `initRothkoScene()` by assigning the local `zones` array (already uses `{ x, y, width, height }` schema from `buildRothkoZones()`). `initRothkoScene()` is called synchronously inside `draw()` before `noLoop()` — `rothkoZones` is always populated before `initStrips()` could run.
- `rowHeights` is **not used** in Rothko mode; use `rothkoZones` exclusively
- Each strip: `pg.get(zone.x, zone.y, zone.width, zone.height)`
- Strip width = `zone.width` (may be less than `pg.width` when margins are present)
- Strips composite at `destX=zone.x, destY=zone.y` on `animatedPg`
- Background fill (`animatedPg.background(config.bgColor)`) preserves margins between zones
- **Zone clipping required:** because `destX + offset` can exceed `zone.x + zone.width`, each Rothko strip must be drawn inside a canvas clip rect to prevent bleed into adjacent zones or margins. Use `drawingContext` directly:

```javascript
animatedPg.drawingContext.save();
animatedPg.drawingContext.beginPath();
animatedPg.drawingContext.rect(zone.x, zone.y, zone.width, zone.height);
animatedPg.drawingContext.clip();
animatedPg.image(rowStrips[i], destX + offset,      destY);
animatedPg.image(rowStrips[i], destX + offset - sw, destY);
animatedPg.drawingContext.restore();
```

Mosaic strips are full canvas width so no clipping is needed.

## Animation Init (`initStrips()`)

Called once on first spacebar press (guarded by `stripsReady`):

1. Create `animatedPg = createGraphics(pg.width, pg.height)`
2. Seed direction/speed RNG: `const animRng = createRng(config.animSeed)`
3. Determine strips from mode: mosaic → `rowHeights` (derive Y positions), Rothko → `rothkoZones`
4. For each strip `i`:
   - Capture image from `pg`
   - `rowDirections[i] = animRng() < 0.5 ? -1 : 1`
   - `rowSpeeds[i] = 0.5 + animRng() * 3.5`
5. `rowOffsets` initialized to `0` for all strips. Note: strips with `direction = -1` will have offset go negative immediately; the modulus expression `((offset % sw) + sw) % sw` handles negative values correctly in JS — no special initialization needed.
6. Set `stripsReady = true`

## draw() Changes

`frameRate(24)` added in `setup()` **before** `noLoop()`. `noLoop()` must remain in place after the initial render — `loop()` / `noLoop()` toggling via spacebar fully controls animation cadence from that point.

Each frame when `animating === true`:

```
animatedPg.background(config.bgColor)
for each strip i:
    const sw = rowStrips[i].width          // per-strip wrap modulus (pg.width for mosaic, zone.width for Rothko)
    const offset = ((rowOffsets[i] % sw) + sw) % sw   // computed once; normalize to [0, sw), handles negatives
    // For Rothko: wrap drawing inside drawingContext clip rect (see Strip Geometry above)
    animatedPg.image(rowStrips[i], destX + offset,      destY)  // primary tile
    animatedPg.image(rowStrips[i], destX + offset - sw, destY)  // wrap tile (may be off-screen at offset=0; that is correct)
    rowOffsets[i] += rowSpeeds[i] * rowDirections[i]             // mutate after draw
image(animatedPg, 0, 0, width, height)
```

When `animating === false` (including the final frame after `noLoop()` is called), draw() displays `pg`: `image(pg, 0, 0, width, height)`.

`frameRate(24)` is set at the top of `setup()`, before the render block and before `noLoop()`.

## keyPressed() Changes

| Key | Action |
|-----|--------|
| Spacebar | Toggle `animating`. First press: call `initStrips()` if `!stripsReady`. Call `loop()` when starting, `noLoop()` when stopping. |
| `s` / `S` | `save(pg, hash + '.png')` — static render (unchanged) |
| `a` / `A` | `save(animatedPg, hash + '-anim.png')` — saves the last composited frame; only when `stripsReady === true`; silently ignored if `stripsReady === false` (spacebar never pressed) |

## File Changes

`sketch.js` only. No new files.

## FXHASH Determinism

The animation display canvas is never captured by `$fx.preview()` — preview fires once from `pg` before any animation starts. `animatedPg` exists only as a viewer-side display layer. `config.animSeed` is deterministic (burned from `R()`), so strip direction and speed are the same every load — but animation position at any given moment is not deterministic (depends on elapsed time), which is intentional.
