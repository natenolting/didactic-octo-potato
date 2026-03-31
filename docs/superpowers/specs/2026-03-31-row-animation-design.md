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
| `rowHeights` | number[] | Promoted from local in setup() to module-level |
| `rothkoZones` | object[] | Populated in initRothkoScene(); zone geometry for strip capture |
| `animating` | boolean | Animation running state; toggled by spacebar |
| `stripsReady` | boolean | Guards one-time strip capture |

`config.animSeed` — new config value burned from `R()` in `setup()` alongside `config.grainSeed`. Used to seed `createRng(config.animSeed)` for deterministic per-token directions and speeds.

## Strip Geometry

### Mosaic mode

- `rowHeights` promoted to module-level global (currently local to setup())
- Row Y positions derived as cumulative sum of `rowHeights`
- Each strip: `pg.get(0, rowY, pg.width, rowH)`
- Strip width = `pg.width`
- Strips composite at `destX=0, destY=rowY` on `animatedPg`

### Rothko mode

- `rothkoZones` stored as module-level global, populated at the end of `initRothkoScene()`
- Each strip: `pg.get(zone.x, zone.y, zone.width, zone.height)`
- Strip width = `zone.width`
- Strips composite at `destX=zone.x, destY=zone.y` on `animatedPg`
- Background fill (`animatedPg.background(config.bgColor)`) preserves margins between zones

## Animation Init (`initStrips()`)

Called once on first spacebar press (guarded by `stripsReady`):

1. Create `animatedPg = createGraphics(pg.width, pg.height)`
2. Seed direction/speed RNG: `const animRng = createRng(config.animSeed)`
3. Determine strip count and geometry (mosaic: `rowHeights.length`; Rothko: `rothkoZones.length`)
4. For each strip:
   - Capture image from `pg`
   - `rowDirections[i] = animRng() < 0.5 ? -1 : 1`
   - `rowSpeeds[i] = 0.5 + animRng() * 3.5`
5. `rowOffsets` initialized to `0`
6. Set `stripsReady = true`

## draw() Changes

`frameRate(24)` added in `setup()`. `noLoop()` still called after first render completes.

Each frame when `animating === true`:

```
animatedPg.background(config.bgColor)
for each strip i:
    offset = ((rowOffsets[i] % stripW) + stripW) % stripW   // wrap
    animatedPg.image(strip, destX + offset,        destY)
    animatedPg.image(strip, destX + offset - stripW, destY)
    rowOffsets[i] += rowSpeeds[i] * rowDirections[i]
image(animatedPg, 0, 0, width, height)
```

When `animating === false`, draw() displays `pg` as before: `image(pg, 0, 0, width, height)`.

## keyPressed() Changes

| Key | Action |
|-----|--------|
| Spacebar | Toggle `animating`. First press: call `initStrips()` if `!stripsReady`. Call `loop()` when starting, `noLoop()` when stopping. |
| `s` / `S` | `save(pg, hash + '.png')` — static render (unchanged) |
| `a` / `A` | `save(animatedPg, hash + '-anim.png')` — current animated frame (only if `stripsReady`) |

## File Changes

`sketch.js` only. No new files.

## FXHASH Determinism

The animation display canvas is never captured by `$fx.preview()` — preview fires once from `pg` before any animation starts. `animatedPg` exists only as a viewer-side display layer. `config.animSeed` is deterministic (burned from `R()`), so direction and speed are the same every load — but the animation position at any given moment is not deterministic (it depends on elapsed time), which is intentional.
