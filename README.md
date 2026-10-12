# Golf Flight Demo

Babylon.js + TypeScript + Vite demo for visualizing launch-monitor-style golf shots in a browser. The product goal is believable, stable shot analysis, not a full golf game.

## Screenshot

![Golf Flight Demo execution screen](./assets/Figure1.png)

## Features

- Browser-based 3D hole with real relief (driving-zone dip, raised green plateau, valley sides, rough mounds, raised tee box), irregular bunkers, a pond, a cart path, tree lines, flag, tee markers, and distance markers
- Terrain-aware physics: the ball lands, bounces off slopes, and rolls downhill on the same terrain that is drawn
- Semi-realistic look: an HDRI sky that also lights every PBR material, a matching shadow-casting sun, and distance haze
- PBR terrain textured with CC0 photo detail and normal maps, with no visible tiling, mowing stripes, a checkered green, and raked bunkers; surface edges sit exactly on the physics surface boundaries
- A pond with depth-tinted water, shore foam, ripples, and (on High) a planar reflection
- Trees generated in code from CC0 leaf, needle, and bark photos, with wind sway, crossed-card grass clumps in the rough, and a far forest drawn as baked impostors
- Two graphics presets, Standard and High, set in one table in `src/render/renderConfig.ts`
- Post-processing with MSAA or FXAA, restrained bloom, ACES tone mapping, and SSAO
- Structured JSON shot input with centralized unit normalization to SI units
- Custom fixed-timestep ballistics with gravity, drag, Magnus-style lift and curve, spin decay, bounce, skid, and roll
- Calibration profiles for `driver`, `long_iron`, `short_iron`, `wedge`, and `putt_like`
- Environment and landing-surface response support for wind, altitude, dry/wet/normal ground, and fairway/rough/green/bunker rollout differences
- Analysis-first UI with camera modes, trajectory modes, comparison overlay, baseline shot selection, and live metrics
- Expanded sample bundle for stock, draw/fade, hook/slice, wedge, bullet driver, wind, wet/dry, and green-release scenarios

## Run

1. Install dependencies:

   ```bash
   npm install
   ```

2. Start the dev server:

   ```bash
   npm run dev
   ```

3. Build for production:

   ```bash
   npm run build
   ```

## Coordinate System

The simulation uses one explicit convention everywhere:

- `+Y` = up
- `+Z` = downrange / target line
- `+X` = golfer's right
- `launchAngle` = elevation above the horizontal plane
- `launchDirection` = horizontal start direction relative to target line
- Positive `sideSpin` / positive `spinAxis` = fade or slice toward `+X`

Backspin is attached to the local `-right` axis so lift remains upward even when the shot starts left or right of center.

## Shot Input

Shot input is JSON and supports optional unit declarations. If units are omitted, defaults are:

- speed: `mph`
- angle: `deg`
- spin: `rpm`

Example:

```json
{
  "name": "Custom Fade",
  "ballSpeed": 158,
  "launchAngle": 13,
  "launchDirection": 1.5,
  "backSpin": 2700,
  "sideSpin": 750,
  "clubType": "driver",
  "environment": {
    "windSpeed": 8,
    "windDirection": 12,
    "groundCondition": "dry"
  },
  "units": {
    "speed": "mph",
    "angle": "deg",
    "spin": "rpm"
  }
}
```

Primary shot fields:

- `ballSpeed`
- `launchAngle`
- `launchDirection`
- `backSpin`
- `sideSpin`
- `totalSpin`
- `spinAxis`

Optional extension fields:

- `clubType`
- `environment`
- `surfaceOverride`
- launch-monitor style secondary fields such as `clubPath`, `faceAngle`, `attackAngle`, `dynamicLoft`, and others

Optional values never block simulation.

## Physics Assumptions

- The aerodynamic model is a stable Magnus-style approximation, not a rigid-body spin-axis solver and not a vendor formula clone.
- Drag, backspin lift, sidespin curve, and spin decay all run inside a deterministic fixed timestep integrator.
- Wind is applied through relative air velocity, so drag and lift respond to the ball's speed through moving air rather than through the ground frame.
- Profile calibration is multiplicative. Each profile biases the same base coefficients instead of switching to an entirely different solver.
- If no `clubType` is supplied, the simulation still uses the driver profile by default and separately computes a recommended profile for analysis display.

## Terrain-Aware Ground

The ball lands, bounces, and rolls on the same terrain that is drawn (`src/core/collision.ts`). The simulation takes an optional `groundHeightResolver`; without one the ground is the flat `y = 0` plane and every rule reduces to the level-ground behaviour.

- The shot starts on top of the raised tee box. Apex is measured from that launch ground, so the tee height does not inflate it; carry and total stay horizontal distances.
- A landing splits the velocity along the ground normal: the normal part rebounds with the surface restitution and the part along the ground is damped. Balls kick off mounds and banks accordingly.
- On the ground, slopes pull the ball downhill (at 5/7 of gravity along the slope, as for a rolling sphere). The ball only comes to rest once the surface friction can hold it on the slope.
- The ground normal is estimated from the height field by central differences.

The hole has real relief: a dip in the driving zone, a climb to a raised green plateau, a valley whose sides rise to the tree lines, mounds in the rough, a raised tee box, bunkers with irregular outlines and built-up lips, and a pond right of the driving zone.

## Surface Model

Surface classification is shared by rendering and physics. The field currently resolves:

- `tee`
- `fairway`
- `rough`
- `green`
- `bunker`
- `fringe`
- `water` (the pond: the ball never bounces, is stopped within a few steps, and settles on the pond bed)

The cart path is decorative; the physics treats the ground under it as rough.

Each surface has its own configurable:

- restitution
- skid damping
- skid friction
- roll friction
- bounce threshold
- spin retention

Ground condition then applies another multiplier layer:

- `normal`
- `dry`
- `wet`

This keeps rollout differences simple but visible. The same launch landing on fairway, rough, green, or bunker will produce different post-landing behavior.

## Render Style

The scene aims for a semi-realistic, broadcast-style look built from CC0 photographic assets. The rendering is split into modules:

- `src/render/renderConfig.ts`
  sun, sky, haze, tone, terrain shading, water, and wind settings, plus the `QUALITY_PRESETS` table that holds every per-quality setting
- `src/render/palette.ts`
  painted base colours for course surfaces, props, and overlays (sRGB, with helpers for linear PBR use)
- `src/render/sky.ts`
  the HDRI panorama, used as both the visible sky and image-based lighting, rotated so its sun matches the directional light
- `src/render/terrain.ts`
  procedural hole layout, rolling height field, soft surface weights, and the surface classification thresholds shared with the physics
- `src/render/materials.ts`, `src/render/terrainPbrPlugin.ts`, and `src/render/terrainTextures.ts`
  a baked surface mask and tint map, plus a PBR material plugin that blends photo detail and normal texture arrays per surface; each surface edge is drawn at the same weight the physics uses to classify it
- `src/render/water.ts`
  the pond surface: depth tint, shore foam, ripples, and the planar reflection
- `src/render/treeGenerator.ts` and `src/render/foliageTextures.ts`
  seeded procedural trees (broadleaf, conifer, bush): bark tubes and alpha-tested leaf-cluster cards composed from the photo atlases
- `src/render/vegetation.ts`
  placement of corridor trees, bushes, rough grass, and the far forest; trees are kept off the pond, the cart path, and anything beyond the modelled terrain
- `src/render/impostor.ts`
  bakes each tree from eight directions into an atlas and draws distant copies as camera-facing quads
- `src/render/windPlugin.ts`
  vertex sway and flutter shared by trees, bushes, and grass
- `src/render/shadows.ts`
  static sun shadows from the trees, drawn once into a single map
- `src/render/courseDetails.ts`
  the cart path draped over the terrain
- `src/render/props.ts`
  flag, cup, tee markers, distance markers, and backdrop hills
- `src/render/postProcess.ts`
  anti-aliasing, bloom, tone mapping, colour grading, and SSAO
- `src/render/scene.ts`
  scene orchestration, lighting, fog, cameras, and terrain-to-physics surface lookup

Vegetation loads asynchronously: the course renders immediately, the trees and grass appear once their textures are composed, and the far forest appears once its impostors are baked. If loading fails, the scene logs a warning and stays fully usable without them.

The ball uses a white clear-coated material with dimple normal detail and a little emission, so it stays readable against both sky and grass.

### Assets

Every third-party file in `public/` is CC0 (Poly Haven and ambientCG) and is listed with its source and processing in `public/LICENSE.md`. The processed files are committed. To refresh them, run:

```bash
python scripts/fetch-assets.py            # everything
python scripts/fetch-assets.py vegetation # only foliage and bark textures
```

The script needs Python 3, and `ffmpeg` / `ffprobe` on `PATH` to decode the HDRI.

## Analysis UX

The panel is designed around rapid shot reading:

- camera modes: `broadcast`, `chase`, `dispersion`
- trajectory modes: `full`, `carry_only`, `roll_only`, `comparison`
- comparison sources: `previous` or `baseline`
- always-visible metrics:
  - ball speed
  - launch
  - spin
  - carry
  - total
  - apex
  - offline
  - landing angle
  - descent angle
  - hang time

The current shot is highlighted in warm colors. Comparison overlays render in a cooler color with a separate landing stack.

## Project Structure

- `src/types/shot.ts`: shot input, optional environment, and normalized data model
- `src/types/simulation.ts`: replay, comparison, session, calibration, and analysis result types
- `src/core/unitConversion.ts`: validation and unit normalization to SI
- `src/core/shotMapper.ts`: shot data to initial velocity and spin vectors
- `src/core/calibration.ts`: profile resolution, environment state building, and effective surface response
- `src/core/ballistics.ts`: deterministic fixed-timestep flight simulation
- `src/core/collision.ts`: bounce, skid, roll, and surface friction
- `src/core/physicsConfig.ts`: centralized tunable constants
- `src/render/renderConfig.ts`: lighting, environment, shading constants, and graphics quality presets
- `src/render/palette.ts`: painted surface, prop, and overlay colours
- `src/render/ballRenderer.ts`: ball mesh, clear-coat material, and shadow disc
- `src/render/terrain.ts`: procedural hole terrain (non-uniform grid, bunker bowls, green contour), surface lookup, and classification thresholds
- `src/render/materials.ts`: terrain surface mask and tint maps, and prop materials
- `src/render/terrainPbrPlugin.ts`: PBR material plugin that paints and textures the terrain surfaces
- `src/render/terrainTextures.ts`: terrain detail and normal texture arrays
- `src/render/sky.ts`: HDRI sky and image-based lighting
- `src/render/shadows.ts`: sun shadow generator per quality preset
- `src/render/water.ts`: pond water surface and reflection
- `src/render/treeGenerator.ts`: procedural tree, conifer, and bush meshes
- `src/render/foliageTextures.ts`: leaf-cluster, needle, grass, and bark textures
- `src/render/vegetation.ts`: tree, bush, grass, and forest placement
- `src/render/impostor.ts`: impostor baking and billboard material for the far forest
- `src/render/windPlugin.ts`: wind sway material plugin
- `src/render/courseDetails.ts`: cart path
- `src/render/props.ts`: pin, tee and distance markers, and backdrop hills
- `src/render/postProcess.ts`: post-processing pipeline and graphics quality switch
- `src/render/proceduralNoise.ts`: shared deterministic hash and noise helpers
- `src/render/scene.ts`: scene orchestration and camera control
- `src/render/trajectoryRenderer.ts`: current and comparison trajectory overlays
- `src/ui/debugPanel.ts`: DOM analysis panel and tuning controls
- `src/data/sampleShots.ts`: validation scenarios and comparison shots

## Performance Controls

The panel's Graphics select switches between two presets defined in `QUALITY_PRESETS` (`src/render/renderConfig.ts`):

| Setting | Standard | High |
|---|---|---|
| Anti-aliasing | FXAA | FXAA |
| Bloom | off | on |
| Static shadow map | 2048 px | 4096 px |
| SSAO | off | on |
| Terrain anti-tiling | off | on |
| Pond reflection | sky only | planar reflection of trees and banks, redrawn every second frame |
| Rough grass density | 55% | 100% |

Both presets hold 60 fps on an integrated laptop GPU. On an AMD Radeon 780M at 1600 x 900, a frame takes about 6 to 8 ms on Standard and 8 to 13 ms on High. Before these settings, the most expensive passes there were 4x MSAA (about 5 ms) and re-rendering cascaded shadows every frame (about 3 ms). The trees themselves cost about 1 ms. `msaaSamples` in the preset table can turn MSAA back on for a discrete GPU.

Other choices that keep the frame cheap:

- terrain uses one procedural mesh with a non-uniform grid: sub-metre triangles around the tee and green complex, coarse triangles in the outskirts
- each tree variant is one merged mesh; corridor trees are instances with a per-copy tint, and only trees near the hole cast shadows
- trees and sun never move, so the shadow map is drawn once and reused; the ball draws its own contact shadow instead of casting into it
- the far forest is a few hundred impostor quads drawn as thin instances (one draw call per tree variant); it grows only on the modelled terrain, just deep enough to close the horizon
- rough grass is thin instances of one crossed-card clump; Standard draws a random subset of them
- the live readouts in the panel update ten times a second, not every frame
- the physics samples the terrain height function directly (a few lookups per step), not the rendered mesh, so ground contact costs no mesh queries

The current largest browser cost is still the Babylon bundle size. Vite build passes, but the final chunk is large and can be code-split later if needed.

## Known Limitations

- Real launch monitor aerodynamic formulas are proprietary and are not reproduced here.
- Calibration profiles are tuned for believable differences, not vendor-validated yardages.
- Surface response is simplified and does not model turf penetration, spin loft, ball deformation, or moisture absorption in detail.
- Green behavior is approximated through friction and damping. Detailed check-and-release behavior would need a richer spin-ground model.
- The field is a single procedural hole demo, not a reusable course editor.
- The ground is a height field: no overhangs, and a ball on the ground stays glued to it rather than going airborne over a sharp crest.
- Ground contact uses the analytic height function; the rendered mesh interpolates it between vertices, so the two can differ by a few centimetres on steep features.
- Trees are procedural approximations built from photo cards, not scanned models. Impostors show eight fixed views, so a far tree can visibly switch views as the camera orbits.
- Shadows are static: they don't sway with the wind, and grass and impostors cast none. The ball casts no sun shadow; a contact shadow sits directly under it.
