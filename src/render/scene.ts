import {
  AbstractMesh,
  ArcRotateCamera,
  Color3,
  Color4,
  DirectionalLight,
  Engine,
  HemisphericLight,
  ImageProcessingConfiguration,
  Mesh,
  MeshBuilder,
  Scene,
  ShadowGenerator,
  Vector3,
  VertexBuffer,
} from "@babylonjs/core";
import { createFieldMaterials } from "./materials";
import { populateFieldProps } from "./props";
import { createFieldModel, createTerrainMesh } from "./terrain";
import type {
  ReplayCameraMode,
  ShotAnalysisMetrics,
  SimulationFrame,
  SurfaceType,
} from "../types/simulation";

export interface SceneController {
  engine: Engine;
  scene: Scene;
  setActiveCamera(cameraName: ReplayCameraMode): void;
  attachFollowTarget(target: AbstractMesh): void;
  updateReplayCamera(frame: SimulationFrame, metrics: ShotAnalysisMetrics): void;
  getSurfaceTypeAt(x: number, z: number): SurfaceType;
  /**
   * Visual terrain height. The physics ground is the y = 0 plane, so renderers
   * add this to simulated positions to keep the ball on the drawn surface.
   */
  getGroundHeightAt(x: number, z: number): number;
  resize(): void;
}

interface OrbitLimits {
  minBeta: number;
  maxBeta: number;
  minRadius: number;
  maxRadius: number;
}

/**
 * A replay camera plus the manual offset the viewer has dialled in on top of its
 * automatic pose. The auto pose is recomputed from the shot every frame, so the
 * offset is what keeps a user-dragged angle from being overwritten immediately.
 *
 * This only holds while updateReplayCamera runs on every rendered frame, even
 * while playback is paused: that is what lets the manual contribution be read
 * back before the next auto pose is written over it.
 */
interface OrbitRig {
  camera: ArcRotateCamera;
  limits: OrbitLimits;
  alphaOffset: number;
  betaOffset: number;
  /** Zoom is a ratio, not a delta: the auto radius itself swings a lot mid-flight. */
  radiusRatio: number;
  lastAutoAlpha: number;
  lastAutoBeta: number;
  lastAutoRadius: number;
}

const TWO_PI = Math.PI * 2;
const WHEEL_DELTA_PERCENTAGE = 0.02;

// Late-morning sun from the golfer's front-right; the sky texture paints its
// glow at the matching spot on the dome.
const SUN_LIGHT_DIRECTION = new Vector3(-0.48, -1, 0.14);
const SUN_COLOR = new Color3(1, 0.95, 0.86);
const SUN_INTENSITY = 1.5;
const SKY_LIGHT_COLOR = new Color3(0.78, 0.86, 1);
const SKY_LIGHT_INTENSITY = 0.6;
const GROUND_BOUNCE_COLOR = new Color3(0.31, 0.35, 0.24);
const FOG_COLOR = new Color3(0.84, 0.9, 0.96);
const FOG_DENSITY = 0.0012;

// Big enough to enclose the backdrop hills; fog hides the far side anyway.
const SKY_DOME_DIAMETER_M = 2400;

const SHADOW_MAP_SIZE = 2048;
const SHADOW_BIAS = 0.0008;
const SHADOW_NORMAL_BIAS = 0.02;

const TONEMAP_EXPOSURE = 1.7;
const TONEMAP_CONTRAST = 1.05;
const VIGNETTE_WEIGHT = 1.4;
const CHASE_INITIAL_ALPHA = -Math.PI / 2;
const CHASE_ALPHA_SMOOTHING = 0.08;

// Each rig pushes its limits onto its camera, so these stay the single source of
// truth for both our own clamping and Babylon's input clamping.
const CHASE_LIMITS: OrbitLimits = {
  minBeta: 0.55,
  maxBeta: 1.38,
  minRadius: 10,
  maxRadius: 46,
};

const BROADCAST_LIMITS: OrbitLimits = {
  minBeta: 0.6,
  maxBeta: 1.42,
  minRadius: 28,
  maxRadius: 220,
};

const DISPERSION_LIMITS: OrbitLimits = {
  minBeta: 0.22,
  maxBeta: 0.88,
  minRadius: 70,
  maxRadius: 280,
};

const clamp = (value: number, min: number, max: number): number =>
  Math.max(min, Math.min(max, value));

/** Shortest signed form of an angle, in [-PI, PI]. Returns NaN rather than looping. */
const wrapAngle = (value: number): number => value - TWO_PI * Math.round(value / TWO_PI);

const lerpTowards = (current: Vector3, goal: Vector3, alpha: number): void => {
  current.x += (goal.x - current.x) * alpha;
  current.y += (goal.y - current.y) * alpha;
  current.z += (goal.z - current.z) * alpha;
};

/**
 * Texture coordinate on the sky dome that faces a world direction, expressed
 * as (u, v) with v = 0 at the zenith and v = 1 at the nadir. Reading the dome's
 * own vertex data avoids depending on the sphere builder's UV convention.
 */
const findSkyUvTowards = (dome: Mesh, direction: Vector3): { u: number; v: number } => {
  const positions = dome.getVerticesData(VertexBuffer.PositionKind);
  const uvs = dome.getVerticesData(VertexBuffer.UVKind);
  if (!positions || !uvs) {
    return { u: 0.5, v: 0.2 };
  }

  const target = direction.normalizeToNew();
  let bestDot = -Infinity;
  let bestIndex = 0;
  let topV = 0;
  let topY = -Infinity;
  let bottomV = 1;
  let bottomY = Infinity;

  for (let index = 0; index < positions.length / 3; index += 1) {
    const x = positions[index * 3];
    const y = positions[index * 3 + 1];
    const z = positions[index * 3 + 2];
    const length = Math.hypot(x, y, z) || 1;
    const dot = (x * target.x + y * target.y + z * target.z) / length;
    if (dot > bestDot) {
      bestDot = dot;
      bestIndex = index;
    }
    if (y > topY) {
      topY = y;
      topV = uvs[index * 2 + 1];
    }
    if (y < bottomY) {
      bottomY = y;
      bottomV = uvs[index * 2 + 1];
    }
  }

  const v = uvs[bestIndex * 2 + 1];
  return {
    u: uvs[bestIndex * 2],
    v: (v - topV) / (bottomV - topV || 1),
  };
};

const createOrbitRig = (
  scene: Scene,
  name: string,
  alpha: number,
  beta: number,
  radius: number,
  target: Vector3,
  limits: OrbitLimits,
): OrbitRig => {
  const camera = new ArcRotateCamera(name, alpha, beta, radius, target, scene);
  camera.lowerBetaLimit = limits.minBeta;
  camera.upperBetaLimit = limits.maxBeta;
  camera.lowerRadiusLimit = limits.minRadius;
  camera.upperRadiusLimit = limits.maxRadius;
  camera.wheelDeltaPercentage = WHEEL_DELTA_PERCENTAGE;
  // The auto pose owns the look-at point, and Babylon pans by mutating the
  // target vector in place, so panning would only fight the shot tracking.
  camera.panningSensibility = 0;

  return {
    camera,
    limits,
    alphaOffset: 0,
    betaOffset: 0,
    radiusRatio: 1,
    lastAutoAlpha: alpha,
    lastAutoBeta: beta,
    lastAutoRadius: radius,
  };
};

/**
 * Read back whatever the viewer's drag or wheel added on top of the pose we
 * wrote last frame. Babylon applies camera input during scene.render(), which
 * runs after updateReplayCamera, so this difference is exactly the manual part.
 */
const captureManualOffsets = (rig: OrbitRig): void => {
  rig.alphaOffset = wrapAngle(rig.camera.alpha - rig.lastAutoAlpha);
  rig.betaOffset = rig.camera.beta - rig.lastAutoBeta;
  rig.radiusRatio = rig.camera.radius / Math.max(rig.lastAutoRadius, 0.001);
};

const applyOrbitPose = (
  rig: OrbitRig,
  lookAt: Vector3,
  lookAtLerp: number,
  baseAlpha: number,
  baseBeta: number,
  baseRadius: number,
): void => {
  const { camera, limits } = rig;

  // Mutating camera.target in place keeps Babylon's view-matrix cache correct
  // without the rebuildAnglesAndRadius() that a setTarget() call would trigger.
  lerpTowards(camera.target, lookAt, lookAtLerp);

  camera.alpha = baseAlpha + rig.alphaOffset;
  camera.beta = clamp(baseBeta + rig.betaOffset, limits.minBeta, limits.maxBeta);
  camera.radius = clamp(baseRadius * rig.radiusRatio, limits.minRadius, limits.maxRadius);

  rig.lastAutoAlpha = baseAlpha;
  rig.lastAutoBeta = baseBeta;
  rig.lastAutoRadius = baseRadius;
};

export const createSceneController = (canvas: HTMLCanvasElement): SceneController => {
  const engine = new Engine(canvas, true, {
    preserveDrawingBuffer: true,
    stencil: true,
  });
  const scene = new Scene(engine);
  scene.clearColor = new Color4(0.8, 0.9, 1, 1);
  scene.fogMode = Scene.FOGMODE_EXP2;
  scene.fogDensity = FOG_DENSITY;
  scene.fogColor = FOG_COLOR;

  // Filmic tone mapping applies inside every StandardMaterial and PBRMaterial,
  // so no post-process pass is needed for it.
  const imageProcessing = scene.imageProcessingConfiguration;
  imageProcessing.toneMappingEnabled = true;
  imageProcessing.toneMappingType = ImageProcessingConfiguration.TONEMAPPING_ACES;
  imageProcessing.exposure = TONEMAP_EXPOSURE;
  imageProcessing.contrast = TONEMAP_CONTRAST;
  imageProcessing.vignetteEnabled = true;
  imageProcessing.vignetteWeight = VIGNETTE_WEIGHT;
  imageProcessing.vignetteColor = new Color4(0, 0, 0, 0);

  const skyDome = MeshBuilder.CreateSphere(
    "sky-dome",
    {
      diameter: SKY_DOME_DIAMETER_M,
      segments: 32,
      sideOrientation: Mesh.BACKSIDE,
    },
    scene,
  );
  skyDome.isPickable = false;
  const sunUv = findSkyUvTowards(skyDome, SUN_LIGHT_DIRECTION.scale(-1));

  const field = createFieldModel();
  const materials = createFieldMaterials(scene, field, sunUv);
  skyDome.material = materials.sky;

  const terrain = createTerrainMesh(scene, field);
  terrain.material = materials.terrain;
  terrain.receiveShadows = true;

  const hemiLight = new HemisphericLight(
    "hemi-light",
    new Vector3(-0.12, 1, -0.08),
    scene,
  );
  hemiLight.intensity = SKY_LIGHT_INTENSITY;
  hemiLight.diffuse = SKY_LIGHT_COLOR;
  hemiLight.groundColor = GROUND_BOUNCE_COLOR;

  const sun = new DirectionalLight("sun-light", SUN_LIGHT_DIRECTION.clone(), scene);
  sun.intensity = SUN_INTENSITY;
  sun.diffuse = SUN_COLOR;
  sun.specular = SUN_COLOR;
  sun.position = new Vector3(92, 130, -46);

  const shadowGenerator = new ShadowGenerator(SHADOW_MAP_SIZE, sun);
  shadowGenerator.usePercentageCloserFiltering = true;
  shadowGenerator.filteringQuality = ShadowGenerator.QUALITY_MEDIUM;
  shadowGenerator.bias = SHADOW_BIAS;
  shadowGenerator.normalBias = SHADOW_NORMAL_BIAS;

  populateFieldProps(scene, field, materials, shadowGenerator);

  const rigs: Record<ReplayCameraMode, OrbitRig> = {
    chase: createOrbitRig(
      scene,
      "chase-camera",
      CHASE_INITIAL_ALPHA,
      1.08,
      18,
      new Vector3(0, 3.2, 0),
      CHASE_LIMITS,
    ),
    broadcast: createOrbitRig(
      scene,
      "broadcast-camera",
      -Math.PI / 2.35,
      1.08,
      88,
      new Vector3(0, 16, 140),
      BROADCAST_LIMITS,
    ),
    dispersion: createOrbitRig(
      scene,
      "dispersion-camera",
      -Math.PI / 2,
      0.42,
      190,
      new Vector3(0, 12, 160),
      DISPERSION_LIMITS,
    ),
  };

  let activeCameraMode: ReplayCameraMode = "broadcast";
  // Damped stand-in for the raw travel direction, so the chase camera swings
  // instead of snapping. Replaces the smoothing FollowCamera used to provide.
  let chaseAutoAlpha = CHASE_INITIAL_ALPHA;
  let lastFrameTimeS = 0;

  scene.activeCamera = rigs[activeCameraMode].camera;
  rigs[activeCameraMode].camera.attachControl(canvas, false);

  return {
    engine,
    scene,
    setActiveCamera(cameraName) {
      captureManualOffsets(rigs[activeCameraMode]);
      rigs[activeCameraMode].camera.detachControl();

      activeCameraMode = cameraName;
      scene.activeCamera = rigs[cameraName].camera;
      rigs[cameraName].camera.attachControl(canvas, false);
    },
    attachFollowTarget(target) {
      rigs.chase.camera.target.copyFrom(target.position);
      shadowGenerator.addShadowCaster(target, false);
    },
    updateReplayCamera(frame, metrics) {
      // Only the active camera receives input, so it is the only rig whose pose
      // can have changed behind our back since the last frame.
      captureManualOffsets(rigs[activeCameraMode]);

      const ballPosition = new Vector3(frame.position.x, frame.position.y, frame.position.z);
      const velocity = new Vector3(frame.velocity.x, frame.velocity.y, frame.velocity.z);
      const direction =
        velocity.lengthSquared() > 0.0001 ? velocity.normalize() : new Vector3(0, 0, 1);

      // ArcRotateCamera offsets from its target by (cos alpha, sin alpha) in XZ,
      // so sitting behind the ball means alpha = atan2(-dz, -dx). Smoothing keeps
      // the camera from whipping on a bounce, or when the roll ends and the
      // direction falls back to the target line.
      const chaseAlphaGoal = Math.atan2(-direction.z, -direction.x);
      const replayRestarted = frame.time < lastFrameTimeS;
      lastFrameTimeS = frame.time;
      chaseAutoAlpha = replayRestarted
        ? chaseAlphaGoal
        : chaseAutoAlpha + wrapAngle(chaseAlphaGoal - chaseAutoAlpha) * CHASE_ALPHA_SMOOTHING;

      applyOrbitPose(
        rigs.chase,
        ballPosition.add(new Vector3(0, 1.05 + Math.min(ballPosition.y * 0.08, 3.2), 0)),
        0.12,
        chaseAutoAlpha,
        1.02 - Math.min(ballPosition.y / 320, 0.12),
        15 + Math.min(ballPosition.y * 0.12, 16),
      );

      const landingPoint = metrics.landingPoint
        ? new Vector3(metrics.landingPoint.x, 0, metrics.landingPoint.z)
        : new Vector3(frame.position.x, 0, frame.position.z + 22);

      applyOrbitPose(
        rigs.broadcast,
        new Vector3(
          ballPosition.x * 0.25 + landingPoint.x * 0.75,
          Math.max(6, ballPosition.y * 0.25 + 7),
          Math.max(ballPosition.z + 18, landingPoint.z * 0.82),
        ),
        0.06,
        -Math.PI / 2.34 + Math.sin(frame.time * 0.32) * 0.07,
        1.05 - Math.min(ballPosition.y / 240, 0.16),
        54 + Math.min(ballPosition.y * 0.5, 72),
      );

      const midZ = Math.max(
        120,
        Math.min(field.holeLengthM - 24, (ballPosition.z + landingPoint.z) * 0.5),
      );

      applyOrbitPose(
        rigs.dispersion,
        new Vector3(landingPoint.x * 0.55 + ballPosition.x * 0.45, 4, midZ),
        0.09,
        -Math.PI / 2,
        0.36,
        118 + Math.max(0, landingPoint.z - ballPosition.z) * 0.18,
      );
    },
    getSurfaceTypeAt(x, z) {
      return field.getSurfaceType(x, z);
    },
    getGroundHeightAt(x, z) {
      return field.getHeight(x, z);
    },
    resize() {
      engine.resize();
    },
  };
};
