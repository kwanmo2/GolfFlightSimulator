import {
  Constants,
  DynamicTexture,
  PBRMaterial,
  RawTexture,
  Scene,
  Texture,
} from "@babylonjs/core";
import { PALETTE, toLinearColor3 } from "./palette";
import { clamp, clamp01, smoothstep, valueNoise } from "./proceduralNoise";
import { DEFAULT_GRAPHICS_QUALITY, QUALITY_PRESETS, SUN_TOWARD, TERRAIN_SHADING } from "./renderConfig";
import { SURFACE_THRESHOLDS } from "./terrain";
import type { FieldModel, SurfaceWeights } from "./terrain";
import { TerrainPbrPlugin } from "./terrainPbrPlugin";
import { loadTerrainTextureArrays } from "./terrainTextures";

export interface FieldMaterials {
  terrain: PBRMaterial;
  /** Terrain shading; exposed so quality presets can adjust it. */
  terrainPlugin: TerrainPbrPlugin;
  backdrop: PBRMaterial;
  flag: PBRMaterial;
  pole: PBRMaterial;
  cupHole: PBRMaterial;
  cupRim: PBRMaterial;
  teeMarker: PBRMaterial;
  /** Shared by every tree, bush and grass clump; their colour lives in vertex colours. */
  vegetation: PBRMaterial;
}

interface RgbColor {
  r: number;
  g: number;
  b: number;
}

const TEXTURE_ANISOTROPY = 8;

// Terrain lookup textures cover the whole 540 x 660 m field, so a texel is
// about a third of a metre along the hole.
const LOOKUP_WIDTH = 1024;
const LOOKUP_HEIGHT = 2048;
/** Tint maps encode a multiplier around 1.0 as bytes centred on this value. */
const TINT_NEUTRAL = 128;
/** Horizontal direction toward the sun. */
const SUN_XZ = (() => {
  const length = Math.hypot(SUN_TOWARD.x, SUN_TOWARD.z) || 1;
  return { x: SUN_TOWARD.x / length, z: SUN_TOWARD.z / length };
})();

/**
 * Mowing stripes run lengthwise, following the fairway's centre line: the
 * mower travels toward and away from the tee, so the stripes show strongly
 * from the tee and green cameras (see the shader's view-dependent sheen).
 */
const FAIRWAY_STRIPE_WIDTH_M = 6;

// Large, gentle variation so a fairway never reads as one flat colour.
const BROAD_NOISE_SCALE = 0.02;
const BROAD_NOISE_STRENGTH = 0.08;
const ROUGH_PATCH_SCALE = 0.035;
const ROUGH_PATCH_STRENGTH = 0.08;
// Sun-dried patches: the rough yellows in broad drifts, the fairway barely.
const DRY_PATCH_SCALE = 0.014;
const DRY_PATCH_START = 0.48;
const DRY_PATCH_FULL = 0.85;
/** Per-channel multiplier shift at a fully dry spot. */
const DRY_SHIFT: RgbColor = { r: 0.24, g: 0.07, b: -0.22 };
const FAIRWAY_DRY_SHARE = 0.3;

const SAND_DAMP_EDGE = 0.1;
/** The pond bed is painted as rough, darkened so it reads as depth through the water. */
const POND_BED_SHADE = 0.55;
const SAND_WALL_SHADE = 0.14;

// Roughness for the PBR surfaces: grass and sand scatter almost all light,
// painted props have a soft satin sheen, leaves sit in between.
const TERRAIN_ROUGHNESS = 0.92;
const PAINT_ROUGHNESS = 0.55;
const FOLIAGE_ROUGHNESS = 0.8;
const FLAG_ROUGHNESS = 0.85;

/**
 * Resolve the overlapping surface weights into an exclusive blend that sums to
 * one. Surfaces are stacked in priority order: sand always wins where a bunker
 * is cut into the fairway, the green over its fringe, and so on, with rough
 * filling whatever is left.
 */
const layerWeights = (weights: SurfaceWeights): SurfaceWeights => {
  let remaining = 1;
  const take = (weight: number): number => {
    const taken = Math.min(remaining, clamp01(weight));
    remaining -= taken;
    return taken;
  };

  const water = take(weights.water);
  const bunker = take(weights.bunker);
  const green = take(weights.green);
  const fringe = take(weights.fringe);
  const tee = take(weights.tee);
  const fairway = take(weights.fairway);
  return { water, bunker, green, fringe, tee, fairway, rough: remaining };
};

/**
 * Shade of the bunker wall that faces away from the sun, so the bowl reads
 * even from the high cameras.
 */
const bunkerWallShade = (field: FieldModel, x: number, z: number): number => {
  let shade = 0;
  for (const feature of field.bunkers) {
    const distance = field.getFeatureDistance(x, z, feature);
    if (distance < 1.3) {
      const offsetX = x - feature.centerX;
      const offsetZ = z - feature.centerZ;
      const offsetLength = Math.hypot(offsetX, offsetZ) || 1;
      // Sun sits toward +X / -Z; walls on that side face away from it.
      const facingAway = 0.5 + 0.5 * ((offsetX * SUN_XZ.x + offsetZ * SUN_XZ.z) / offsetLength);
      shade = Math.max(shade, smoothstep(0.5, 1.05, distance) * facingAway);
    }
  }
  return shade;
};

/**
 * Large-scale colour variation layered over the surface colours: soft
 * patches and dry drifts in the rough, a shaded wall in the bunkers.
 * Returns a per-channel multiplier around 1.0.
 */
const sampleTerrainTint = (field: FieldModel, weights: SurfaceWeights, x: number, z: number): RgbColor => {
  const broad = (valueNoise(x * BROAD_NOISE_SCALE, z * BROAD_NOISE_SCALE) - 0.5) * BROAD_NOISE_STRENGTH;
  const patch = (valueNoise(x * ROUGH_PATCH_SCALE + 7.3, z * ROUGH_PATCH_SCALE - 2.1) - 0.5) * ROUGH_PATCH_STRENGTH;
  const dry = smoothstep(
    DRY_PATCH_START,
    DRY_PATCH_FULL,
    valueNoise(x * DRY_PATCH_SCALE + 3.1, z * DRY_PATCH_SCALE - 8.4),
  );

  const rough = 1 + broad + patch * 2;
  const fairway = 1 + broad * 0.5;
  const green = 1 + broad * 0.25;
  const fringe = 1 + broad * 0.5;

  const damp = weights.bunker > 0 ? smoothstep(0.35, 0.9, 1 - weights.bunker) : 0;
  const wallShade = weights.bunker > 0 ? bunkerWallShade(field, x, z) : 0;
  const bunker = 1 - damp * SAND_DAMP_EDGE - wallShade * SAND_WALL_SHADE;

  const value =
    rough * weights.rough +
    fairway * (weights.fairway + weights.tee) +
    green * weights.green +
    fringe * weights.fringe +
    bunker * weights.bunker +
    POND_BED_SHADE * weights.water;
  const dryness = dry * (weights.rough + FAIRWAY_DRY_SHARE * (weights.fairway + weights.tee));
  return {
    r: value * (1 + DRY_SHIFT.r * dryness),
    g: value * (1 + DRY_SHIFT.g * dryness),
    b: value * (1 + DRY_SHIFT.b * dryness),
  };
};

/**
 * Triangle wave across the mowing stripes, 0..1 over two stripes. Filtering
 * keeps a linear ramp exact, so the shader can find the stripe edge at 0.5
 * with sub-texel precision.
 */
const sampleStripeWave = (field: FieldModel, x: number, z: number): number => {
  const stripes = (x - field.getCorridorCenterX(z)) / FAIRWAY_STRIPE_WIDTH_M;
  const phase = stripes / 2 - Math.floor(stripes / 2);
  return Math.abs(phase * 2 - 1);
};

const encodeTint = (value: number): number =>
  Math.round(clamp(value * TINT_NEUTRAL, 0, 255));

const encodeWeight = (value: number): number => Math.round(clamp01(value) * 255);

/**
 * One pass over the field producing both terrain lookups: the surface mask read
 * by TerrainPbrPlugin, and the tint map (RGB tint, A mowing-stripe wave) bound
 * as the material's albedo texture.
 * RawTexture keeps the mask exact; a canvas would premultiply the alpha channel.
 */
const createTerrainLookupTextures = (
  scene: Scene,
  field: FieldModel,
): { mask: Texture; tint: Texture } => {
  const width = LOOKUP_WIDTH;
  const height = LOOKUP_HEIGHT;
  const maskData = new Uint8Array(width * height * 4);
  const tintData = new Uint8Array(width * height * 4);

  for (let py = 0; py < height; py += 1) {
    const z = (py / (height - 1) - 0.5) * field.terrainLengthM;
    for (let px = 0; px < width; px += 1) {
      const x = (px / (width - 1) - 0.5) * field.terrainWidthM;
      const weights = layerWeights(field.getSurfaceWeights(x, z));
      const tint = sampleTerrainTint(field, weights, x, z);
      const index = (py * width + px) * 4;

      maskData[index] = encodeWeight(weights.fairway + weights.tee);
      maskData[index + 1] = encodeWeight(weights.green);
      maskData[index + 2] = encodeWeight(weights.bunker);
      maskData[index + 3] = encodeWeight(weights.fringe);

      tintData[index] = encodeTint(tint.r);
      tintData[index + 1] = encodeTint(tint.g);
      tintData[index + 2] = encodeTint(tint.b);
      tintData[index + 3] = encodeWeight(sampleStripeWave(field, x, z));
    }
  }

  const createLookup = (name: string, data: Uint8Array): Texture => {
    const texture = RawTexture.CreateRGBATexture(
      data,
      width,
      height,
      scene,
      true,
      false,
      Constants.TEXTURE_TRILINEAR_SAMPLINGMODE,
    );
    texture.name = name;
    texture.wrapU = Texture.CLAMP_ADDRESSMODE;
    texture.wrapV = Texture.CLAMP_ADDRESSMODE;
    texture.anisotropicFilteringLevel = TEXTURE_ANISOTROPY;
    // Both lookups hold data, not colour: no sRGB decode when sampled.
    texture.gammaSpace = false;
    return texture;
  };

  return {
    mask: createLookup("terrain-surface-mask", maskData),
    tint: createLookup("terrain-tint-map", tintData),
  };
};

const createFlagTexture = (scene: Scene): DynamicTexture => {
  const width = 256;
  const height = 160;
  const texture = new DynamicTexture("pin-flag", { width, height }, scene, false);
  const context = texture.getContext() as unknown as CanvasRenderingContext2D;
  context.fillStyle = PALETTE.props.flag;
  context.fillRect(0, 0, width, height);
  context.fillStyle = PALETTE.props.flagText;
  context.font = "bold 110px Segoe UI, Arial, sans-serif";
  context.textAlign = "center";
  context.textBaseline = "middle";
  context.fillText("1", width * 0.5, height * 0.55);
  texture.update(false);
  return texture;
};

/** Non-metallic PBR material in one flat palette colour. */
export const createPaintedMaterial = (
  scene: Scene,
  name: string,
  hex: string,
  roughness = PAINT_ROUGHNESS,
): PBRMaterial => {
  const material = new PBRMaterial(name, scene);
  material.albedoColor = toLinearColor3(hex);
  material.metallic = 0;
  material.roughness = roughness;
  return material;
};

export const createFieldMaterials = (scene: Scene, field: FieldModel): FieldMaterials => {
  const lookups = createTerrainLookupTextures(scene, field);

  const terrain = new PBRMaterial("terrain-material", scene);
  terrain.albedoTexture = lookups.tint;
  terrain.metallic = 0;
  terrain.roughness = TERRAIN_ROUGHNESS;
  const terrainPlugin = new TerrainPbrPlugin(terrain);
  terrainPlugin.setAntiTiling(QUALITY_PRESETS[DEFAULT_GRAPHICS_QUALITY].terrainAntiTiling);
  terrainPlugin.setStyle(
    lookups.mask,
    {
      rough: toLinearColor3(PALETTE.surface.rough),
      firstCut: toLinearColor3(PALETTE.surface.firstCut),
      fairway: toLinearColor3(PALETTE.surface.fairway),
      fringe: toLinearColor3(PALETTE.surface.fringe),
      green: toLinearColor3(PALETTE.surface.green),
      sand: toLinearColor3(PALETTE.surface.sand),
    },
    {
      fairway: SURFACE_THRESHOLDS.fairway,
      green: SURFACE_THRESHOLDS.green,
      bunker: SURFACE_THRESHOLDS.bunker,
      fringe: SURFACE_THRESHOLDS.fringe,
    },
    TERRAIN_SHADING,
  );
  // The course is playable with flat colours; the photo detail fades in once loaded.
  loadTerrainTextureArrays(scene)
    .then((textures) => terrainPlugin.setTextures(textures))
    .catch((error: unknown) => {
      console.warn("Terrain textures failed to load; continuing with flat surfaces.", error);
    });

  const backdrop = createPaintedMaterial(scene, "backdrop-material", PALETTE.surface.backdrop, TERRAIN_ROUGHNESS);

  const flag = createPaintedMaterial(scene, "flag-material", "#ffffff", FLAG_ROUGHNESS);
  flag.albedoTexture = createFlagTexture(scene);
  flag.backFaceCulling = false;
  flag.twoSidedLighting = true;

  // Leaves and grass blades are single-sided cards in the kit, so they are
  // drawn and lit from both sides.
  const vegetation = createPaintedMaterial(scene, "vegetation-material", "#ffffff", FOLIAGE_ROUGHNESS);
  vegetation.backFaceCulling = false;
  vegetation.twoSidedLighting = true;

  return {
    terrain,
    terrainPlugin,
    backdrop,
    flag,
    pole: createPaintedMaterial(scene, "flag-pole-material", PALETTE.props.pole),
    cupHole: createPaintedMaterial(scene, "cup-hole-material", PALETTE.props.cupHole, TERRAIN_ROUGHNESS),
    cupRim: createPaintedMaterial(scene, "cup-rim-material", PALETTE.props.cupRim),
    teeMarker: createPaintedMaterial(scene, "tee-marker-material", PALETTE.props.teeMarker),
    vegetation,
  };
};
