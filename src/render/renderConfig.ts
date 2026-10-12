import { Color3, Vector3 } from "@babylonjs/core";
import type { GraphicsQuality } from "../types/simulation";
import type { TerrainShadingParams } from "./terrainPbrPlugin";

/**
 * Lighting, environment and quality settings for the semi-realistic look.
 * Physically based materials read these; palette.ts keeps the UI, trajectory
 * and prop colours.
 */

const degToRad = (degrees: number): number => (degrees * Math.PI) / 180;

/**
 * Sky panorama, used both as the visible sky and for image-based lighting.
 * The measured values come from `python scripts/fetch-assets.py`, which also
 * caps the sun's luminance so its energy comes from the directional light.
 */
export const ENVIRONMENT = {
  url: "/environment/sky.hdr",
  /** Cube face size the panorama is resampled to; matches a 2K panorama's detail. */
  cubeSizePx: 512,
  /** Direction toward the sun in the unrotated panorama (measured). */
  sunElevationRad: degToRad(47.9),
  /** atan2(z, x) of the direction toward the sun in the unrotated panorama (measured). */
  sunAzimuthRad: degToRad(34.2),
  /** Mean linear colour of the panorama's horizon band (measured). */
  horizonLinear: new Color3(0.4401, 0.4731, 0.5741),
  /** Strength of sky light on physically based materials. */
  lightingIntensity: 1,
  skyboxSizeM: 2000,
} as const;

/**
 * Where the sun sits in the world, as atan2(z, x) of the direction toward it.
 * With +X right and +Z downrange, this puts it behind the golfer's right
 * shoulder: the faces of mounds and trees seen from the tee are lit, and
 * shadows fall forward-left where the cameras can see them.
 */
const SUN_WORLD_AZIMUTH_RAD = degToRad(-26);

/**
 * Rotation that brings the panorama's sun to SUN_WORLD_AZIMUTH_RAD.
 *
 * Measured by rendering azimuth markers against the sky, not derived:
 * HDRCubeTexture mirrors the panorama, so a panorama direction at azimuth phi
 * (atan2(z, x) in the formula fetch-assets.py uses) shows up in the world at
 * 90 deg - phi. The texture's rotationY then adds to the world azimuth.
 */
export const ENVIRONMENT_ROTATION_Y_RAD = SUN_WORLD_AZIMUTH_RAD - (Math.PI / 2 - ENVIRONMENT.sunAzimuthRad);

/** Unit vector from the ground toward the sun. */
export const SUN_TOWARD = new Vector3(
  Math.cos(ENVIRONMENT.sunElevationRad) * Math.cos(SUN_WORLD_AZIMUTH_RAD),
  Math.sin(ENVIRONMENT.sunElevationRad),
  Math.cos(ENVIRONMENT.sunElevationRad) * Math.sin(SUN_WORLD_AZIMUTH_RAD),
);

/** Direction the sunlight travels, for the directional light. */
export const SUN_LIGHT_DIRECTION = SUN_TOWARD.scale(-1);

export const SUN_LIGHT = {
  /** Slightly warm noon sunlight, linear. */
  color: new Color3(1, 0.96, 0.9),
  intensity: 3.2,
  /** Distance back along the sunlight to place the light for shadow depth. */
  shadowDistanceM: 180,
} as const;

/** Aerial perspective: distance haze in the horizon's colour. */
export const ATMOSPHERE = {
  fogDensity: 0.0009,
  /** Haze is a touch brighter than the measured horizon so far trees fade to sky, not grey. */
  fogBrightness: 1.15,
} as const;

export const TONE = {
  exposure: 1,
  contrast: 1.12,
  /** ColorCurves saturation, -100..100. */
  saturation: 0,
  vignetteWeight: 1.2,
} as const;

/**
 * Terrain shading (see TerrainPbrPlugin). Tile sizes are the real-world size
 * of one photo, so grass blades come out at a believable scale.
 */
export const TERRAIN_SHADING: TerrainShadingParams = {
  firstCutWeight: 0.16,
  minEdgeSoftness: 0.012,
  stripeContrast: 0.07,
  greenCheckerWidthM: 2.4,
  greenCheckerContrast: 0.05,
  tileSizeM: { rough: 1.4, fairway: 1.1, green: 0.8, sand: 2.2 },
  normalStrength: { rough: 1.1, fairway: 0.7, green: 0.45, sand: 0.6 },
  detailContrast: { rough: 1.3, fairway: 1.1, green: 0.8, sand: 1.2 },
  detailSaturation: 0.4,
  mottleStrength: 0.09,
  mottleScaleM: 4,
  farBlendStartM: 25,
  farBlendEndM: 90,
  farTileMultiplier: 9,
  rakeSpacingM: 0.09,
  rakeStrength: 0.35,
  rakeAngleRad: 0.6,
  rakeFadeEndM: 45,
};

/** Pond surface (see water.ts). Colours are linear. */
export const WATER = {
  /** Silty green-brown where the bed shows through. */
  shallow: new Color3(0.09, 0.11, 0.06),
  shallowAlpha: 0.55,
  /** Dark blue-green body of deeper water. */
  deep: new Color3(0.012, 0.03, 0.035),
  deepAlpha: 0.96,
  /** Depth at which the water reads fully deep, metres. */
  deepAtM: 0.8,
  roughness: 0.04,
  indexOfRefraction: 1.333,
  rippleStrength: 0.08,
  rippleFadeStartM: 40,
  rippleFadeEndM: 220,
  /** Foam covers depths below foamStartM, fading out by foamEndM. */
  foamStartM: 0.09,
  foamEndM: 0.15,
  foamStrength: 0.4,
  /** Strength of the planar reflection on the "high" preset. */
  mirrorLevel: 0.9,
} as const;

/** Breeze shared by every swaying plant (see windPlugin.ts); a unit XZ direction. */
export const WIND = {
  directionX: 0.8,
  directionZ: 0.6,
} as const;

export interface QualityPreset {
  /**
   * Size of the static sun shadow map. It is drawn once, so a larger map
   * costs memory and a little sampling, not a per-frame render.
   */
  shadowMapSizePx: number;
  ssao: boolean;
  /**
   * Multisampling of the HDR scene target; 1 uses FXAA instead. MSAA is the
   * single most expensive pass on an integrated GPU (around 5 ms at
   * 1600 x 900 on a Radeon 780M, as much at 2 samples as at 4), and it does
   * nothing for alpha-tested foliage.
   */
  msaaSamples: number;
  /** Bloom only catches the sun's glare on water and the ball's highlight. */
  bloom: boolean;
  /** Cross-fade that hides terrain texture repetition, at twice the texture fetches. */
  terrainAntiTiling: boolean;
  /** Planar reflection of trees and banks in the pond; otherwise it mirrors only the sky. */
  waterReflection: boolean;
  /** Share of the rough's grass clumps drawn. */
  grassDensity: number;
}

/**
 * Every per-quality setting in one table. "standard" targets 60 fps on an
 * integrated laptop GPU with margin to spare; "high" adds SSAO, bloom,
 * terrain anti-tiling, the pond reflection and full grass, and also aims for
 * 60 fps there.
 */
export const QUALITY_PRESETS: Record<GraphicsQuality, QualityPreset> = {
  standard: {
    shadowMapSizePx: 2048,
    ssao: false,
    msaaSamples: 1,
    bloom: false,
    terrainAntiTiling: false,
    waterReflection: false,
    grassDensity: 0.55,
  },
  high: {
    shadowMapSizePx: 4096,
    ssao: true,
    msaaSamples: 1,
    bloom: true,
    terrainAntiTiling: true,
    waterReflection: true,
    grassDensity: 1,
  },
};

export const DEFAULT_GRAPHICS_QUALITY: GraphicsQuality = "high";
