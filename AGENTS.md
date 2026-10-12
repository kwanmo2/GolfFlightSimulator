# AGENTS.md

## Project
Shot-data-driven golf ball flight demo built with Babylon.js.

## Goal
Create a browser-based 3D demo that visualizes a golf ball flying over a field using launch monitor style shot data.
The primary goal is believable and stable ball flight visualization, not a full golf game.

## Product Scope
The app should:
- Accept shot data as structured JSON input.
- Convert shot data into initial ball conditions.
- Simulate ball flight in 3D.
- Render the ball, trajectory, landing point, and roll.
- Show a simple field environment.
- Provide a debug UI for tuning physics constants.

The app does NOT need:
- Full golf gameplay loops
- Club swing animation
- Character/avatar system
- Multiplayer
- Course editor
- Full tournament rules

## Target Stack
- Babylon.js
- TypeScript
- Vite
- HTML/CSS
- Optional lightweight GUI for debug controls

## Core Simulation Rules
Use a custom projectile simulation for in-flight ball motion.
Do not rely solely on rigid body physics for aerodynamic flight.

The simulation should include:
- Gravity
- Drag
- Magnus-like lift / side force from spin
- Spin decay over time
- Ground bounce
- Ground roll with material-dependent friction

## Input Data Model
Prioritize these fields:
- ballSpeed
- launchAngle
- launchDirection
- backSpin
- sideSpin
- totalSpin
- spinAxis

Secondary / optional fields:
- clubPath
- faceAngle
- attackAngle
- dynamicLoft
- clubHeadSpeed
- impactPointHV
- lowPoint
- swingPlane
- swingDirection
- clubLie
- closureRate
- faceToAxis

The code must tolerate missing optional values.

## Units
Normalize all inputs internally to SI units.
Examples:
- speed -> m/s
- angles -> radians internally
- spin -> rpm input, converted as needed
- distances -> meters

All conversions must be centralized in one module.

## Coordinate System
Define and document the coordinate system clearly.

Recommended convention:
- +Y = up
- +Z = downrange / target direction
- +X = right
- launchAngle = elevation from horizontal plane
- launchDirection = horizontal angle relative to target line

Do not leave sign conventions ambiguous.
Document left/right and draw/fade conventions in comments.

## Architecture
Structure the code into clear modules:

- `src/types/shot.ts`
  - shot data interfaces

- `src/core/unitConversion.ts`
  - input normalization and validation

- `src/core/shotMapper.ts`
  - convert shot data to initial velocity and spin vectors

- `src/core/ballistics.ts`
  - numerical integration of flight
  - drag, lift, spin decay

- `src/core/collision.ts`
  - landing, bounce, roll

- `src/render/scene.ts`
  - Babylon scene setup, lighting, fog, cameras

- `src/render/renderConfig.ts`
  - sun, sky, haze, tone, terrain, water, and wind constants
  - `QUALITY_PRESETS`: every per-quality setting in one table

- `src/render/terrain.ts`, `materials.ts`, `terrainPbrPlugin.ts`, `terrainTextures.ts`
  - height field, surface classification shared with physics, PBR terrain shading

- `src/render/sky.ts`, `shadows.ts`, `postProcess.ts`, `water.ts`
  - HDRI sky and image-based lighting, sun shadows, post stack, pond

- `src/render/vegetation.ts`, `treeGenerator.ts`, `foliageTextures.ts`, `impostor.ts`, `windPlugin.ts`
  - procedural trees from photo textures, placement, far-forest impostors, wind sway

- `src/render/ballRenderer.ts`
  - ball mesh and visual updates

- `src/render/trajectoryRenderer.ts`
  - trail / polyline / markers

- `src/ui/debugPanel.ts`
  - live parameter tuning and shot injection

- `src/data/sampleShots.ts`
  - sample driver / iron / wedge shots

## MVP Definition
The first working version must:
- load a Babylon.js scene
- spawn a golf ball
- simulate flight from input shot data
- show visible draw/fade from spin
- show landing and roll
- display carry distance, apex, total distance
- allow replay of sample shots

## Physics Guidance
Prefer stable and tunable behavior over overcomplicated realism.
Use fixed timestep simulation for deterministic results.
Keep aerodynamic coefficients configurable.

Avoid pretending to be launch-monitor-accurate unless calibration data exists.

## Rendering Guidance
The scene should look clean and readable:
- one tee area
- fairway-like ground
- skybox or simple sky
- follow camera and overview camera
- optional impact and landing markers
- visible trajectory line

The ball must remain visually trackable during flight.

The current look is semi-realistic (broadcast golf style): HDRI sky with
image-based lighting, PBR materials, photo-textured terrain without visible
tiling, procedural trees built from photo leaf cards.

Rules for scenery:
- Vegetation and props stay on the modelled terrain (`terrainWidthM` x
  `terrainLengthM`, centred on the origin). Nothing grows over the backdrop.
- Keep trees off the pond, the cart path, and the playing corridor.
- Distant trees are impostors, not full geometry. Don't add scenery that is
  only visible from far away; the backdrop hills close the horizon.
- Vegetation loads asynchronously; a failed load must leave a usable course.

## Assets
- Third-party assets must be CC0 (Poly Haven, ambientCG, or similar).
- `scripts/fetch-assets.py` downloads and processes them into `public/`;
  the processed files are committed.
- Record every asset with its source, licence, and processing in
  `public/LICENSE.md`.
- Keep each asset to a few MB. Poly Haven tree glTFs (25–215 MB each) were
  rejected for this reason.

## Performance Budget
- Graphics presets live in `QUALITY_PRESETS` (`src/render/renderConfig.ts`).
- "standard" must hold 60 fps (under 16.7 ms per frame) on an integrated
  laptop GPU (reference: AMD Radeon 780M at 1600 x 900).
- "high" should also hold 60 fps there; it currently runs at about 8 to 13 ms.
- Measure before optimizing. On integrated GPUs the expensive passes are MSAA
  (now off: FXAA instead), per-frame shadow map rendering (now drawn once,
  since all casters are static), the planar water reflection (half rate),
  SSAO, and bloom. Vegetation geometry is cheap.
- Shadow casters must be static. Moving objects draw their own contact
  shadow, as the ball does.
- New expensive effects need a preset flag, and must be off on "standard"
  unless they fit the budget.
- Don't touch the DOM every frame; the live readouts are throttled.

## UX Requirements
Include:
- shot input panel or sample shot selector
- replay button
- pause/reset button
- debug overlay with:
  - current velocity
  - spin
  - height
  - carry
  - total distance
  - apex

## Validation Requirements
Add sample cases such as:
- straight shot
- fade
- draw
- high-spin wedge
- low-spin driver
- no-spin sanity check

Each sample should produce believable differences.

## Code Quality
- Use TypeScript strictly
- Keep functions small and testable
- Avoid giant scene files
- Document assumptions
- Separate physics from rendering
- No magic numbers without named constants

## Deliverables
Codex should generate:
1. project folder structure
2. runnable Babylon.js + TypeScript app
3. sample shot dataset
4. configurable physics constants
5. README with run instructions and known limitations

## Known Limitations to Acknowledge
- aerodynamic model is approximate
- real launch monitor vendor formulas are proprietary
- spin/drag behavior may need calibration
- ground interaction is simplified unless refined later

## Success Criteria
The project is successful if:
- the app runs locally
- different shot inputs visibly change trajectory
- draw/fade behavior is believable
- carry/landing/roll are shown clearly
- the codebase is easy to extend