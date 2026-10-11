import {
  Color3,
  Constants,
  DynamicTexture,
  RawTexture,
  Scene,
  StandardMaterial,
  Texture,
} from "@babylonjs/core";
import { PALETTE, toColor3 } from "./palette";
import { clamp, clamp01, smoothstep, valueNoise } from "./proceduralNoise";
import { SURFACE_THRESHOLDS } from "./terrain";
import type { FieldModel, SurfaceWeights } from "./terrain";
import { TerrainStylePlugin } from "./terrainStylePlugin";

export interface FieldMaterials {
  terrain: StandardMaterial;
  backdrop: StandardMaterial;
  flag: StandardMaterial;
  pole: StandardMaterial;
  cupHole: StandardMaterial;
  cupRim: StandardMaterial;
  teeMarker: StandardMaterial;
  /** Shared by every tree, bush and grass clump; their colour lives in vertex colours. */
  vegetation: StandardMaterial;
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
/** Horizontal direction toward the sun (see SUN_LIGHT_DIRECTION in scene.ts). */
const SUN_XZ = { x: 0.9, z: -0.435 };

// Mowing stripes run across the fairway.
const FAIRWAY_STRIPE_WIDTH_M = 6;
const FAIRWAY_STRIPE_CONTRAST = 0.04;

// Large, gentle colour variation keeps the flat colours from looking like paper.
const BROAD_NOISE_SCALE = 0.02;
const BROAD_NOISE_STRENGTH = 0.06;
const ROUGH_PATCH_SCALE = 0.035;
const ROUGH_PATCH_STRENGTH = 0.05;

const SAND_DAMP_EDGE = 0.1;
/** The pond bed is painted as rough, darkened so it reads as depth through the water. */
const POND_BED_SHADE = 0.55;
const SAND_WALL_SHADE = 0.14;

/** Faint highlight on painted props: enough to show their shape without looking glossy. */
const PROP_SPECULAR = new Color3(0.08, 0.08, 0.08);

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
 * Large-scale brightness variation layered over the flat surface colours:
 * mowing stripes on the fairway, soft patches in the rough, a shaded wall in
 * the bunkers. Returns a per-channel multiplier around 1.0.
 */
const sampleTerrainTint = (field: FieldModel, weights: SurfaceWeights, x: number, z: number): RgbColor => {
  const broad = (valueNoise(x * BROAD_NOISE_SCALE, z * BROAD_NOISE_SCALE) - 0.5) * BROAD_NOISE_STRENGTH;
  const patch = (valueNoise(x * ROUGH_PATCH_SCALE + 7.3, z * ROUGH_PATCH_SCALE - 2.1) - 0.5) * ROUGH_PATCH_STRENGTH;
  const stripe = Math.floor(z / FAIRWAY_STRIPE_WIDTH_M) % 2 === 0 ? 1 : -1;

  const rough = 1 + broad + patch * 2;
  const fairway = 1 + stripe * FAIRWAY_STRIPE_CONTRAST + broad * 0.5;
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
  return { r: value, g: value, b: value };
};

const encodeTint = (value: number): number =>
  Math.round(clamp(value * TINT_NEUTRAL, 0, 255));

const encodeWeight = (value: number): number => Math.round(clamp01(value) * 255);

/**
 * One pass over the field producing both terrain lookups: the surface mask read
 * by TerrainStylePlugin and the tint map bound as the material's diffuse texture.
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
      tintData[index + 3] = 255;
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

const createFlatMaterial = (scene: Scene, name: string, hex: string): StandardMaterial => {
  const material = new StandardMaterial(name, scene);
  material.diffuseColor = toColor3(hex);
  material.specularColor = PROP_SPECULAR.clone();
  return material;
};

export const createFieldMaterials = (scene: Scene, field: FieldModel): FieldMaterials => {
  const lookups = createTerrainLookupTextures(scene, field);

  const terrain = new StandardMaterial("terrain-material", scene);
  terrain.diffuseTexture = lookups.tint;
  terrain.specularColor = Color3.Black();
  new TerrainStylePlugin(terrain).setStyle(
    lookups.mask,
    {
      rough: toColor3(PALETTE.surface.rough),
      firstCut: toColor3(PALETTE.surface.firstCut),
      fairway: toColor3(PALETTE.surface.fairway),
      fringe: toColor3(PALETTE.surface.fringe),
      green: toColor3(PALETTE.surface.green),
      sand: toColor3(PALETTE.surface.sand),
    },
    {
      fairway: SURFACE_THRESHOLDS.fairway,
      green: SURFACE_THRESHOLDS.green,
      bunker: SURFACE_THRESHOLDS.bunker,
      fringe: SURFACE_THRESHOLDS.fringe,
    },
  );

  const backdrop = createFlatMaterial(scene, "backdrop-material", PALETTE.surface.backdrop);
  backdrop.specularColor = Color3.Black();

  const flag = new StandardMaterial("flag-material", scene);
  flag.diffuseTexture = createFlagTexture(scene);
  flag.specularColor = Color3.Black();
  flag.backFaceCulling = false;

  // Leaves and grass blades are single-sided cards in the kit, so they are
  // drawn and lit from both sides.
  const vegetation = new StandardMaterial("vegetation-material", scene);
  vegetation.diffuseColor = Color3.White();
  vegetation.specularColor = Color3.Black();
  vegetation.backFaceCulling = false;
  vegetation.twoSidedLighting = true;

  return {
    terrain,
    backdrop,
    flag,
    pole: createFlatMaterial(scene, "flag-pole-material", PALETTE.props.pole),
    cupHole: createFlatMaterial(scene, "cup-hole-material", PALETTE.props.cupHole),
    cupRim: createFlatMaterial(scene, "cup-rim-material", PALETTE.props.cupRim),
    teeMarker: createFlatMaterial(scene, "tee-marker-material", PALETTE.props.teeMarker),
    vegetation,
  };
};
