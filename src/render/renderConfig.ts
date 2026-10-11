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

export interface QualityPreset {
  /** Cascaded shadows: sharp near the camera, still covering the whole hole. */
  cascadedShadows: boolean;
  shadowMapSizePx: number;
  /** Cascades used when cascadedShadows is on. */
  shadowCascades: number;
  ssao: boolean;
  /** Cross-fade that hides terrain texture repetition, at twice the texture fetches. */
  terrainAntiTiling: boolean;
}

/**
 * Every per-quality setting in one table. "standard" targets 60 fps on an
 * integrated laptop GPU; "high" assumes a discrete GPU.
 */
export const QUALITY_PRESETS: Record<GraphicsQuality, QualityPreset> = {
  standard: {
    cascadedShadows: false,
    shadowMapSizePx: 1024,
    shadowCascades: 1,
    ssao: false,
    terrainAntiTiling: false,
  },
  high: {
    cascadedShadows: true,
    shadowMapSizePx: 2048,
    shadowCascades: 3,
    ssao: true,
    terrainAntiTiling: true,
  },
};

export const DEFAULT_GRAPHICS_QUALITY: GraphicsQuality = "high";
