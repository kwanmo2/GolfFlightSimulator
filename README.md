# Golf Flight Demo

Babylon.js + TypeScript + Vite demo for visualizing launch-monitor-style golf shots in a browser. The product goal is believable, stable shot analysis, not a full golf game.

## Features

- Browser-based 3D hole scene with rolling terrain, fairway corridor, green complex, bunkers, tree line, flag, tee markers, and distance markers
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

## Surface Model

Surface classification is shared by rendering and physics. The field currently resolves:

- `tee`
- `fairway`
- `rough`
- `green`
- `bunker`
- `fringe`

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

## Render Realism System

The field rendering is split into coarse modules:

- `src/render/terrain.ts`
  procedural hole layout, rolling height field, and soft surface classification
- `src/render/materials.ts`
  blended terrain color map, detail textures, sky material, grass card material, and surface patch materials
- `src/render/props.ts`
  green/bunker/tee patches, flag, hole cup, tee markers, tree bands, distance markers, and near-camera grass instances
- `src/render/scene.ts`
  scene orchestration, lighting, fog, sky dome, cameras, and terrain-to-physics surface lookup

Material blending uses a baked procedural terrain map as the "equivalent shader approach" for soft transitions between fairway, rough, fringe, green, tee, and bunker zones. Large-scale variation is baked into the terrain map, while repeated bump/detail textures add local texture without obvious tiling.

The ball remains a sphere mesh, but uses a procedural PBR material with dimple normal detail for a more golf-ball-like read during replay.

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
- `src/render/ballRenderer.ts`: ball mesh, dimpled material, and shadow disc
- `src/render/terrain.ts`: procedural hole terrain and surface lookup
- `src/render/materials.ts`: terrain, sky, patch, and prop materials
- `src/render/props.ts`: flag, markers, trees, grass, and background props
- `src/render/scene.ts`: scene orchestration and camera control
- `src/render/trajectoryRenderer.ts`: current and comparison trajectory overlays
- `src/ui/debugPanel.ts`: DOM analysis panel and tuning controls
- `src/data/sampleShots.ts`: validation scenarios and comparison shots

## Performance Controls

The rendering path stays browser-friendly by design:

- terrain uses one procedural mesh instead of editable terrain tooling
- the corridor is visually richer than the distant background
- near-camera grass is instance-based and only generated around tee/green/playable areas
- tree bands are instance-based and use simple low-cost meshes
- terrain transitions are baked into generated textures instead of using a complex runtime terrain editor or multi-pass material stack

The current largest browser cost is still the Babylon bundle size. Vite build passes, but the final chunk is large and can be code-split later if needed.

## Known Limitations

- Real launch monitor aerodynamic formulas are proprietary and are not reproduced here.
- Calibration profiles are tuned for believable differences, not vendor-validated yardages.
- Surface response is simplified and does not model turf penetration, spin loft, ball deformation, or moisture absorption in detail.
- Green behavior is approximated through friction and damping. Detailed check-and-release behavior would need a richer spin-ground model.
- The field is a single procedural hole demo, not a reusable course editor.
