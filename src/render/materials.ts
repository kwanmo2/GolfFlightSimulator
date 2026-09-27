import {
  Color3,
  Constants,
  DynamicTexture,
  RawTexture,
  Scene,
  StandardMaterial,
  Texture,
} from "@babylonjs/core";
import type { FieldModel, SurfaceWeights } from "./terrain";
import { TerrainSplatPlugin } from "./terrainSplatPlugin";

export interface FieldMaterials {
  terrain: StandardMaterial;
  backdrop: StandardMaterial;
  sky: StandardMaterial;
  flag: StandardMaterial;
  pole: StandardMaterial;
  cupHole: StandardMaterial;
  cupRim: StandardMaterial;
  teeMarker: StandardMaterial;
  treeTrunk: StandardMaterial;
  treeCanopy: StandardMaterial;
  grassCard: StandardMaterial;
}

interface RgbColor {
  r: number;
  g: number;
  b: number;
}

/** Tiled CC0 textures from ambientCG; see public/textures/LICENSE.md. */
const TEXTURE_ROOT = "/textures/";
const TEXTURE_ANISOTROPY = 8;

// Terrain lookup textures cover the whole 540 x 660 m field, so a texel is
// about half a metre. Fine detail comes from the tiled textures instead.
const LOOKUP_WIDTH = 1024;
const LOOKUP_HEIGHT = 2048;
/** Tint maps encode a multiplier around 1.0 as bytes centred on this value. */
const TINT_NEUTRAL = 128;
/** Horizontal direction toward the sun (see SUN_LIGHT_DIRECTION in scene.ts). */
const SUN_XZ = { x: 0.96, z: -0.28 };

const clamp = (value: number, min: number, max: number): number =>
  Math.max(min, Math.min(max, value));

const clamp01 = (value: number): number => clamp(value, 0, 1);

const smoothstep = (edge0: number, edge1: number, value: number): number => {
  const t = clamp01((value - edge0) / (edge1 - edge0));
  return t * t * (3 - 2 * t);
};

const hash2 = (x: number, z: number): number => {
  const value = Math.sin(x * 127.1 + z * 311.7) * 43758.5453123;
  return value - Math.floor(value);
};

/** Smooth value noise in [0, 1] from bilinear blending of hash2 on an integer lattice. */
const valueNoise = (x: number, z: number): number => {
  const x0 = Math.floor(x);
  const z0 = Math.floor(z);
  const tx = x - x0;
  const tz = z - z0;
  const sx = tx * tx * (3 - 2 * tx);
  const sz = tz * tz * (3 - 2 * tz);
  const top = hash2(x0, z0) + (hash2(x0 + 1, z0) - hash2(x0, z0)) * sx;
  const bottom = hash2(x0, z0 + 1) + (hash2(x0 + 1, z0 + 1) - hash2(x0, z0 + 1)) * sx;
  return top + (bottom - top) * sz;
};

const createDynamicTexture = (
  scene: Scene,
  name: string,
  width: number,
  height: number,
  painter: (
    context: CanvasRenderingContext2D,
    width: number,
    height: number,
  ) => void,
): DynamicTexture => {
  const texture = new DynamicTexture(name, { width, height }, scene, false);
  const context = texture.getContext() as unknown as CanvasRenderingContext2D;
  painter(context, width, height);
  texture.update(false);
  texture.wrapU = Texture.CLAMP_ADDRESSMODE;
  texture.wrapV = Texture.CLAMP_ADDRESSMODE;
  return texture;
};

const loadTiledTexture = (scene: Scene, fileName: string): Texture => {
  const texture = new Texture(`${TEXTURE_ROOT}${fileName}`, scene);
  texture.wrapU = Texture.WRAP_ADDRESSMODE;
  texture.wrapV = Texture.WRAP_ADDRESSMODE;
  texture.anisotropicFilteringLevel = TEXTURE_ANISOTROPY;
  return texture;
};

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

  const bunker = take(weights.bunker);
  const green = take(weights.green);
  const fringe = take(weights.fringe);
  const tee = take(weights.tee);
  const fairway = take(weights.fairway);
  return { bunker, green, fringe, tee, fairway, rough: remaining };
};

/**
 * Large-scale colour variation layered over the tiled detail textures: mowing
 * stripes on the fairway, dry patches in the rough, damp sand at bunker edges.
 * Returns a per-channel multiplier around 1.0.
 */
const sampleTerrainTint = (field: FieldModel, weights: SurfaceWeights, x: number, z: number): RgbColor => {
  const stripe = Math.floor((z + 18) / 18) % 2 === 0 ? 1 : -1;
  const largeNoise =
    Math.sin(x * 0.05 + z * 0.006) * 0.03 +
    Math.cos(z * 0.031 - x * 0.014) * 0.025 +
    (valueNoise(x * 0.08, z * 0.08) - 0.5) * 0.08;
  const microNoise = (hash2(Math.floor(x * 2), Math.floor(z * 2)) - 0.5) * 0.04;

  const dryPatch = smoothstep(0.58, 0.8, valueNoise(x * 0.035 + 7.3, z * 0.035 - 2.1));
  const roughBase = 1 + largeNoise * 1.3;
  const rough: RgbColor = {
    r: roughBase + dryPatch * 0.1,
    g: roughBase + dryPatch * 0.02,
    b: roughBase - dryPatch * 0.12,
  };

  const fairwayBase = 1 + stripe * 0.06 + largeNoise * 0.6;
  const fairway: RgbColor = { r: fairwayBase, g: fairwayBase, b: fairwayBase };
  const tee: RgbColor = { r: fairwayBase * 0.98, g: fairwayBase, b: fairwayBase * 0.98 };
  const greenBase = 1 + microNoise * 0.3 + largeNoise * 0.2;
  const green: RgbColor = { r: greenBase, g: greenBase, b: greenBase };
  const fringeBase = 0.96 + largeNoise * 0.4;
  const fringe: RgbColor = { r: fringeBase, g: fringeBase, b: fringeBase };

  // Sand is brightest in the centre of the bunker and slightly damp at the
  // edges; the bowl wall that faces away from the sun is shaded so the
  // depression reads even from the high cameras.
  const damp = smoothstep(0.35, 0.9, 1 - weights.bunker);
  const sunWash = clamp01(
    (field.holeLengthM - Math.abs(z - field.green.centerZ)) / field.holeLengthM,
  );
  let wallShade = 0;
  if (weights.bunker > 0) {
    for (const feature of field.bunkers) {
      const distance = field.getFeatureDistance(x, z, feature);
      if (distance < 1.3) {
        const offsetX = x - feature.centerX;
        const offsetZ = z - feature.centerZ;
        const offsetLength = Math.hypot(offsetX, offsetZ) || 1;
        // Sun sits toward +X / -Z; walls on that side face away from it.
        const facingAway = 0.5 + 0.5 * ((offsetX * SUN_XZ.x + offsetZ * SUN_XZ.z) / offsetLength);
        wallShade = Math.max(wallShade, smoothstep(0.5, 1.05, distance) * facingAway);
      }
    }
  }
  const sandBase = 1 + sunWash * 0.04 + microNoise * 0.5 - damp * 0.16 - wallShade * 0.22;
  const bunker: RgbColor = { r: sandBase, g: sandBase, b: sandBase - damp * 0.03 };

  const sources: Array<[RgbColor, number]> = [
    [tee, weights.tee],
    [fairway, weights.fairway],
    [rough, weights.rough],
    [green, weights.green],
    [fringe, weights.fringe],
    [bunker, weights.bunker],
  ];

  const tint: RgbColor = { r: 0, g: 0, b: 0 };
  for (const [source, weight] of sources) {
    tint.r += source.r * weight;
    tint.g += source.g * weight;
    tint.b += source.b * weight;
  }
  return tint;
};

const encodeTint = (value: number): number =>
  Math.round(clamp(value * TINT_NEUTRAL, 0, 255));

const encodeWeight = (value: number): number => Math.round(clamp01(value) * 255);

/**
 * One pass over the field producing both terrain lookups: the splat mask read by
 * TerrainSplatPlugin and the tint map bound as the material's diffuse texture.
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
    mask: createLookup("terrain-splat-mask", maskData),
    tint: createLookup("terrain-tint-map", tintData),
  };
};

const SKY_ZENITH = "#3b70c4";
const SKY_MID = "#6ea6e6";
const SKY_LOW = "#a9cdf0";
const SKY_HORIZON = "#d6e6f4";
const SKY_BELOW_HORIZON = "#c9d8de";
const SKY_NADIR = "#b3c1b0";

/**
 * Equirectangular sky for the dome: zenith at the top of the canvas, horizon
 * at mid height. Clouds are wrapped so the seam at u = 0 is invisible, and the
 * horizon colour matches the scene fog so distant ground fades into it.
 */
const createSkyTexture = (scene: Scene, sunU: number, sunV: number): DynamicTexture =>
  createDynamicTexture(scene, "field-sky", 1024, 1024, (context, width, height) => {
    const gradient = context.createLinearGradient(0, 0, 0, height);
    gradient.addColorStop(0, SKY_ZENITH);
    gradient.addColorStop(0.28, SKY_MID);
    gradient.addColorStop(0.44, SKY_LOW);
    gradient.addColorStop(0.5, SKY_HORIZON);
    gradient.addColorStop(0.53, SKY_BELOW_HORIZON);
    gradient.addColorStop(1, SKY_NADIR);
    context.fillStyle = gradient;
    context.fillRect(0, 0, width, height);

    // Sun glow.
    const sunX = sunU * width;
    const sunY = sunV * height;
    const glow = context.createRadialGradient(sunX, sunY, 0, sunX, sunY, width * 0.32);
    glow.addColorStop(0, "rgba(255, 250, 235, 0.95)");
    glow.addColorStop(0.08, "rgba(255, 245, 220, 0.55)");
    glow.addColorStop(0.35, "rgba(255, 240, 215, 0.14)");
    glow.addColorStop(1, "rgba(255, 240, 215, 0)");
    context.fillStyle = glow;
    context.fillRect(0, 0, width, height);

    // Clouds: soft overlapping puffs, larger and rounder near the zenith,
    // flatter and denser near the horizon.
    const horizonY = height * 0.5;
    for (let cloud = 0; cloud < 70; cloud += 1) {
      const baseX = hash2(cloud, 3.1) * width;
      const altitude = Math.pow(hash2(cloud, 5.7), 0.7);
      const baseY = height * 0.1 + altitude * (horizonY - height * 0.14);
      const nearHorizon = smoothstep(0.55, 1, altitude);
      const puffCount = 3 + Math.floor(hash2(cloud, 8.3) * 4);
      const cloudSize = (36 + hash2(cloud, 2.9) * 70) * (1 - nearHorizon * 0.55);
      const alpha = 0.2 + hash2(cloud, 6.1) * 0.22 + nearHorizon * 0.1;

      for (let puff = 0; puff < puffCount; puff += 1) {
        const offsetX = (hash2(cloud * 13 + puff, 1.7) - 0.5) * cloudSize * 3;
        const offsetY = (hash2(cloud * 13 + puff, 4.3) - 0.5) * cloudSize * 0.7;
        const radius = cloudSize * (0.6 + hash2(cloud * 13 + puff, 9.9) * 0.6);
        const squash = 0.55 - nearHorizon * 0.3;

        for (const wrap of [-width, 0, width]) {
          const centerX = baseX + offsetX + wrap;
          const centerY = baseY + offsetY;
          context.save();
          context.translate(centerX, centerY);
          context.scale(1, squash);
          const puffGradient = context.createRadialGradient(0, 0, 0, 0, 0, radius);
          puffGradient.addColorStop(0, `rgba(255, 255, 255, ${alpha.toFixed(3)})`);
          puffGradient.addColorStop(0.55, `rgba(250, 252, 255, ${(alpha * 0.55).toFixed(3)})`);
          puffGradient.addColorStop(1, "rgba(245, 250, 255, 0)");
          context.fillStyle = puffGradient;
          context.fillRect(-radius, -radius, radius * 2, radius * 2);
          context.restore();
        }
      }
    }
  });

const createGrassCardTexture = (scene: Scene): DynamicTexture =>
  createDynamicTexture(scene, "grass-card", 128, 256, (context, width, height) => {
    context.clearRect(0, 0, width, height);
    for (let i = 0; i < 26; i += 1) {
      const x = width * (0.1 + hash2(i, 2.4) * 0.8);
      const baseY = height - 4;
      const topY = 36 + hash2(i, 5.1) * 60;
      const bend = (hash2(i, 9.2) - 0.5) * 30;
      const r = 112 + Math.round(hash2(i, 1.7) * 34);
      const g = 146 + Math.round(hash2(i, 3.4) * 30);
      const b = 58 + Math.round(hash2(i, 4.6) * 22);
      context.strokeStyle = `rgba(${r}, ${g}, ${b}, 0.88)`;
      context.lineWidth = 2 + hash2(i, 7.4) * 1.8;
      context.lineCap = "round";
      context.beginPath();
      context.moveTo(x, baseY);
      context.quadraticCurveTo(x + bend * 0.4, (baseY + topY) * 0.58, x + bend, topY);
      context.stroke();
    }
  });

const createFlagTexture = (scene: Scene): DynamicTexture =>
  createDynamicTexture(scene, "pin-flag", 256, 160, (context, width, height) => {
    context.fillStyle = "#e23b26";
    context.fillRect(0, 0, width, height);
    // Faint cloth weave so the flag is not a flat fill up close.
    context.strokeStyle = "rgba(255, 255, 255, 0.06)";
    context.lineWidth = 1;
    for (let y = 0; y < height; y += 4) {
      context.beginPath();
      context.moveTo(0, y);
      context.lineTo(width, y);
      context.stroke();
    }
    context.fillStyle = "#fffaf0";
    context.font = "bold 110px Segoe UI, Arial, sans-serif";
    context.textAlign = "center";
    context.textBaseline = "middle";
    context.fillText("1", width * 0.5, height * 0.55);
  });

export const createFieldMaterials = (
  scene: Scene,
  field: FieldModel,
  sunUv: { u: number; v: number },
): FieldMaterials => {
  const lookups = createTerrainLookupTextures(scene, field);

  const terrain = new StandardMaterial("terrain-material", scene);
  terrain.diffuseTexture = lookups.tint;
  // A touch of broad specular gives the green its sheen without making the rough shiny.
  terrain.specularColor = new Color3(0.05, 0.05, 0.04);
  terrain.specularPower = 48;
  const splat = new TerrainSplatPlugin(terrain);
  splat.setLayers({
    mask: lookups.mask,
    roughColor: loadTiledTexture(scene, "grass_rough_color.jpg"),
    roughNormal: loadTiledTexture(scene, "grass_rough_normal.jpg"),
    fairwayColor: loadTiledTexture(scene, "grass_fairway_color.jpg"),
    fairwayNormal: loadTiledTexture(scene, "grass_fairway_normal.jpg"),
    greenColor: loadTiledTexture(scene, "grass_green_color.jpg"),
    greenNormal: loadTiledTexture(scene, "grass_green_normal.jpg"),
    sandColor: loadTiledTexture(scene, "sand_bunker_color.jpg"),
    sandNormal: loadTiledTexture(scene, "sand_bunker_normal.jpg"),
  });

  const backdrop = new StandardMaterial("backdrop-material", scene);
  const backdropTexture = loadTiledTexture(scene, "grass_rough_color.jpg");
  backdropTexture.uScale = 90;
  backdropTexture.vScale = 90;
  backdrop.diffuseTexture = backdropTexture;
  backdrop.diffuseColor = new Color3(0.72, 0.8, 0.7);
  backdrop.specularColor = Color3.Black();

  const sky = new StandardMaterial("sky-material", scene);
  sky.emissiveTexture = createSkyTexture(scene, sunUv.u, sunUv.v);
  sky.diffuseColor = Color3.Black();
  sky.specularColor = Color3.Black();
  sky.disableLighting = true;
  sky.fogEnabled = false;

  const flag = new StandardMaterial("flag-material", scene);
  flag.diffuseTexture = createFlagTexture(scene);
  flag.emissiveColor = new Color3(0.1, 0.03, 0.02);
  flag.specularColor = new Color3(0.12, 0.12, 0.12);
  flag.backFaceCulling = false;

  const pole = new StandardMaterial("flag-pole-material", scene);
  pole.diffuseColor = new Color3(0.92, 0.92, 0.9);
  pole.specularColor = new Color3(0.35, 0.35, 0.35);
  pole.specularPower = 32;

  const cupHole = new StandardMaterial("cup-hole-material", scene);
  cupHole.diffuseColor = new Color3(0.04, 0.05, 0.035);
  cupHole.specularColor = Color3.Black();

  const cupRim = new StandardMaterial("cup-rim-material", scene);
  cupRim.diffuseColor = new Color3(0.95, 0.95, 0.92);
  cupRim.specularColor = new Color3(0.2, 0.2, 0.2);

  const teeMarker = new StandardMaterial("tee-marker-material", scene);
  teeMarker.diffuseColor = new Color3(0.98, 0.97, 0.93);
  teeMarker.specularColor = new Color3(0.12, 0.12, 0.12);

  const treeTrunk = new StandardMaterial("tree-trunk-material", scene);
  treeTrunk.diffuseColor = new Color3(0.33, 0.24, 0.16);
  treeTrunk.specularColor = Color3.Black();

  // Canopy colour lives in the vertex colours of each tree variant.
  const treeCanopy = new StandardMaterial("tree-canopy-material", scene);
  treeCanopy.diffuseColor = new Color3(1, 1, 1);
  treeCanopy.specularColor = Color3.Black();

  const grassCard = new StandardMaterial("grass-card-material", scene);
  grassCard.diffuseTexture = createGrassCardTexture(scene);
  grassCard.diffuseTexture.hasAlpha = true;
  grassCard.useAlphaFromDiffuseTexture = true;
  grassCard.backFaceCulling = false;
  grassCard.specularColor = Color3.Black();
  grassCard.emissiveColor = new Color3(0.2, 0.26, 0.11);

  return {
    terrain,
    backdrop,
    sky,
    flag,
    pole,
    cupHole,
    cupRim,
    teeMarker,
    treeTrunk,
    treeCanopy,
    grassCard,
  };
};
