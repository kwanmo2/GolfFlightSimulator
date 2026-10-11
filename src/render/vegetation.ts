import { Color4, Matrix, Mesh, Quaternion, Scene, Vector3, VertexBuffer } from "@babylonjs/core";
import type { Material } from "@babylonjs/core";
import { loadModels } from "./assetLibrary";
import type { ModelSpec } from "./assetLibrary";
import { PALETTE } from "./palette";
import { hash, smoothstep, valueNoise } from "./proceduralNoise";
import type { ShadowSystem } from "./shadows";
import type { FieldModel } from "./terrain";

export type HeightResolver = (x: number, z: number) => number;

/** Everything near enough to the hole to throw a visible shadow. */
const SHADOW_CASTER_MAX_Z = 320;

// Typical heights; each placement scales around these.
const BROADLEAF_HEIGHT_M = 10.5;
const CONIFER_HEIGHT_M = 13;
const BUSH_HEIGHT_M = 1.6;
const GRASS_HEIGHT_M = 0.34;
const FLOWER_HEIGHT_M = 0.4;

/** Trees are planted slightly into the ground so no gap shows on slopes. */
const TREE_SINK_M = 0.15;
/** Share of corridor trees that are conifers; the perimeter uses an even mix. */
const CORRIDOR_CONIFER_SHARE = 0.3;
const PERIMETER_CONIFER_SHARE = 0.5;

/** Per-instance brightness jitter so neighbouring copies of a model differ. */
const TREE_TINT_RANGE = 0.18;
const GRASS_TINT_RANGE = 0.2;

// Rough grass is scattered on a jittered grid, thinned by noise into patches.
const GRASS_GRID_M = 1.7;
const GRASS_START_Z_M = 10;
const GRASS_END_Z_M = 300;
/** Lateral band beyond the fairway edge that gets grass. */
const GRASS_BAND_M = 42;
const GRASS_PATCH_SCALE = 0.07;
/** Chance of a clump at a grid point in the thickest part of a patch. */
const GRASS_MAX_DENSITY = 0.55;
/** Fairway-side margin where the grass thins out, so balls just offline stay visible. */
const GRASS_FAIRWAY_MARGIN_M = 5;
const BUNKER_LIP_TUFTS = 46;

const FLOWER_PATCHES = 26;
const FLOWERS_PER_PATCH = 9;
/** Flowers only grow well away from the fairway edge. */
const FLOWER_MIN_OFFSET_M = 22;

const BROADLEAF_SPECS: ModelSpec[] = [
  { file: "tree_default.glb", widthScale: 0.85, colors: { leafsGreen: PALETTE.vegetation.leafMid } },
  { file: "tree_oak.glb", widthScale: 1.0, colors: { leafsGreen: PALETTE.vegetation.leafLight } },
  { file: "tree_detailed.glb", widthScale: 0.95, colors: { leafsGreen: PALETTE.vegetation.leafDark } },
  { file: "tree_fat.glb", widthScale: 1.0, colors: { leafsGreen: PALETTE.vegetation.leafMid } },
];
const CONIFER_SPECS: ModelSpec[] = [
  { file: "tree_pineRoundA.glb", widthScale: 0.7 },
  { file: "tree_pineTallA.glb", widthScale: 0.55 },
  { file: "tree_pineDefaultA.glb", widthScale: 0.62 },
];
const BUSH_SPECS: ModelSpec[] = [
  { file: "plant_bush.glb", widthScale: 1.5, colors: { grass: PALETTE.vegetation.bush } },
  { file: "plant_bushLarge.glb", widthScale: 1.7, colors: { grass: PALETTE.vegetation.bush } },
];
const GRASS_SPECS: ModelSpec[] = [
  { file: "grass.glb", widthScale: 1.5 },
  { file: "grass_large.glb", widthScale: 1.5 },
];
const FLOWER_SPECS: ModelSpec[] = [{ file: "flower_yellowA.glb" }, { file: "flower_purpleA.glb" }];

interface Placement {
  x: number;
  z: number;
  /** Multiplier on the model type's typical height. */
  scale: number;
}

/** Trees lining both sides of the corridor, kept clear of the fairway falloff. */
const corridorTreePlacements = (
  field: FieldModel,
  startZ: number,
  endZ: number,
  count: number,
  lateralOffset: number,
  scaleMin: number,
  scaleMax: number,
  seedOffset: number,
): Placement[] => {
  const placements: Placement[] = [];
  for (let index = 0; index < count; index += 1) {
    const t = count <= 1 ? 0 : index / (count - 1);
    const z = startZ + (endZ - startZ) * t + (hash(index * 17.3 + seedOffset) - 0.5) * 8;
    const center = field.getCorridorCenterX(z);
    const side = index % 2 === 0 ? -1 : 1;
    const x = center + side * (lateralOffset + hash(index * 9.1 + seedOffset) * 30);
    placements.push({ x, z, scale: scaleMin + hash(index * 4.7 + seedOffset) * (scaleMax - scaleMin) });
  }
  return placements;
};

/** A ring of trees around the whole field so no camera sees bare terrain edge. */
const perimeterTreePlacements = (field: FieldModel): Placement[] => {
  const placements: Placement[] = [];
  const halfWidth = field.terrainWidthM / 2;
  const halfLength = field.terrainLengthM / 2;

  // Back wall behind the green, densest where the broadcast camera looks.
  for (let index = 0; index < 64; index += 1) {
    const x = -260 + (520 / 63) * index + (hash(index * 2.1 + 40) - 0.5) * 12;
    const z = 318 + hash(index * 5.3 + 41) * 40;
    placements.push({ x, z, scale: 1 + hash(index * 7.7 + 42) * 0.45 });
  }
  // Side rows, spaced so they read as a wood line rather than a fence.
  for (let index = 0; index < 40; index += 1) {
    const z = -halfLength + 40 + (halfLength * 2 - 80) * (index / 39) + (hash(index * 3.9 + 50) - 0.5) * 20;
    for (const side of [-1, 1]) {
      const x = side * (halfWidth - 60 - hash(index * 4.1 + 51 + side) * 90);
      placements.push({ x, z, scale: 0.95 + hash(index * 6.3 + 52 + side) * 0.4 });
    }
  }
  // Behind the tee.
  for (let index = 0; index < 22; index += 1) {
    const x = -180 + (360 / 21) * index + (hash(index * 2.3 + 60) - 0.5) * 14;
    const z = -60 - hash(index * 4.9 + 61) * 60;
    placements.push({ x, z, scale: 0.9 + hash(index * 8.1 + 62) * 0.45 });
  }
  return placements;
};

/** A couple of bushes in front of each corridor tree, on the side facing the fairway. */
const bushPlacements = (field: FieldModel, trees: Placement[]): Placement[] => {
  const placements: Placement[] = [];
  trees.forEach((tree, index) => {
    const towardFairway = Math.sign(field.getCorridorCenterX(tree.z) - tree.x) || 1;
    for (let bush = 0; bush < 2; bush += 1) {
      const seed = index * 5.1 + bush * 1.7 + 300;
      placements.push({
        x: tree.x + towardFairway * (2.5 + hash(seed) * 5),
        z: tree.z + (hash(seed + 0.4) - 0.5) * 9,
        scale: 0.7 + hash(seed + 0.8) * 0.6,
      });
    }
  });
  return placements;
};

const tintFor = (seed: number, range: number): Color4 => {
  const shade = 1 - range / 2 + hash(seed) * range;
  return new Color4(shade, shade, shade, 1);
};

/**
 * Classic instances share their source's buffers by kind, so a tint registered
 * as "color" would replace the per-vertex palette colours. The instance kind
 * multiplies with them instead.
 */
const INSTANCE_TINT_KIND = VertexBuffer.ColorInstanceKind;

/** Hide an instance source and give it a per-instance tint buffer. Call once per source. */
const prepareInstanceSources = (sources: Mesh[]): void => {
  sources.forEach((source) => {
    source.registerInstancedBuffer(INSTANCE_TINT_KIND, 4);
    source.instancedBuffers[INSTANCE_TINT_KIND] = new Color4(1, 1, 1, 1);
    source.isVisible = false;
  });
};

/**
 * Instances of one or more source models, cycling through them. Instances keep
 * per-copy shadow casting, which the corridor trees need and thin instances lack.
 */
const placeInstances = (
  sources: Mesh[],
  placements: Placement[],
  typicalHeightM: number,
  namePrefix: string,
  heightAt: HeightResolver,
  shadowGenerator: ShadowSystem | null,
): void => {
  placements.forEach((placement, index) => {
    const pick = hash(placement.x * 0.37 + placement.z * 0.11);
    const source = sources[Math.floor(pick * sources.length)];
    const instance = source.createInstance(`${namePrefix}-${index}`);
    const height = typicalHeightM * placement.scale;
    const girth = height * (0.9 + hash(index * 1.9) * 0.2);
    instance.position.set(placement.x, heightAt(placement.x, placement.z) - TREE_SINK_M, placement.z);
    instance.rotation.y = hash(index * 3.3 + 0.5) * Math.PI * 2;
    instance.scaling.set(girth, height, girth);
    instance.instancedBuffers[INSTANCE_TINT_KIND] = tintFor(index * 4.3 + 0.7, TREE_TINT_RANGE);
    instance.isPickable = false;
    if (shadowGenerator && placement.z < SHADOW_CASTER_MAX_Z) {
      shadowGenerator.addShadowCaster(instance);
    }
  });
};

/**
 * Thin instances for the dense, shadowless ground cover: one draw call per
 * model regardless of how many clumps are placed.
 */
const placeThinInstances = (
  sources: Mesh[],
  placements: Placement[],
  typicalHeightM: number,
  heightAt: HeightResolver,
): void => {
  const buckets = sources.map(() => ({ matrices: [] as number[], colors: [] as number[] }));
  placements.forEach((placement, index) => {
    const bucket = buckets[Math.floor(hash(index * 1.3 + 0.2) * sources.length)];
    const height = typicalHeightM * placement.scale;
    const matrix = Matrix.Compose(
      new Vector3(height, height, height),
      Quaternion.RotationAxis(Vector3.Up(), hash(index * 0.7 + 0.5) * Math.PI * 2),
      new Vector3(placement.x, heightAt(placement.x, placement.z), placement.z),
    );
    bucket.matrices.push(...matrix.toArray());
    const tint = tintFor(index * 2.1 + 0.9, GRASS_TINT_RANGE);
    bucket.colors.push(tint.r, tint.g, tint.b, 1);
  });

  sources.forEach((source, index) => {
    const { matrices, colors } = buckets[index];
    if (matrices.length === 0) {
      source.setEnabled(false);
      return;
    }
    source.thinInstanceSetBuffer("matrix", new Float32Array(matrices), 16, true);
    source.thinInstanceSetBuffer("color", new Float32Array(colors), 4, true);
  });
};

/**
 * Grass clumps in the rough, in noise-driven patches that thin out toward the
 * fairway, plus a ring of tufts around each bunker lip.
 */
const grassPlacements = (field: FieldModel): Placement[] => {
  const placements: Placement[] = [];
  let seed = 0;
  for (let z = GRASS_START_Z_M; z < GRASS_END_Z_M; z += GRASS_GRID_M) {
    const center = field.getCorridorCenterX(z);
    const fairwayEdge = field.getFairwayHalfWidth(z);
    for (const side of [-1, 1]) {
      for (let offset = 0; offset < GRASS_BAND_M; offset += GRASS_GRID_M) {
        seed += 1;
        const x = center + side * (fairwayEdge + offset + hash(seed * 1.3) * GRASS_GRID_M);
        const sampleZ = z + hash(seed * 2.1) * GRASS_GRID_M;
        const weights = field.getSurfaceWeights(x, sampleZ);
        if (weights.rough < 0.75 || weights.bunker > 0.02 || weights.green > 0.02 || weights.fringe > 0.05) {
          continue;
        }
        const patch = smoothstep(0.35, 0.7, valueNoise(x * GRASS_PATCH_SCALE, sampleZ * GRASS_PATCH_SCALE));
        const nearFairway = smoothstep(0, GRASS_FAIRWAY_MARGIN_M, offset);
        if (hash(seed * 3.7) < patch * nearFairway * GRASS_MAX_DENSITY) {
          placements.push({ x, z: sampleZ, scale: 0.7 + hash(seed * 4.3) * 0.6 });
        }
      }
    }
  }

  for (const bunker of field.bunkers) {
    for (let index = 0; index < BUNKER_LIP_TUFTS; index += 1) {
      seed += 1;
      const angle = (index / BUNKER_LIP_TUFTS) * Math.PI * 2 + (hash(seed) - 0.5) * 0.1;
      const distance = 1.3 + hash(seed * 1.7) * 0.25;
      const cos = Math.cos(bunker.angleRad);
      const sin = Math.sin(bunker.angleRad);
      const localX = Math.cos(angle) * bunker.radiusX * distance;
      const localZ = Math.sin(angle) * bunker.radiusZ * distance;
      const x = bunker.centerX + localX * cos - localZ * sin;
      const z = bunker.centerZ + localX * sin + localZ * cos;
      if (field.getSurfaceWeights(x, z).green < 0.3) {
        placements.push({ x, z, scale: 0.8 + hash(seed * 2.3) * 0.5 });
      }
    }
  }
  return placements;
};

/** Small clusters of wildflowers out in the deep rough. */
const flowerPlacements = (field: FieldModel): Placement[] => {
  const placements: Placement[] = [];
  for (let patch = 0; patch < FLOWER_PATCHES; patch += 1) {
    const z = GRASS_START_Z_M + hash(patch * 3.1 + 900) * (GRASS_END_Z_M - GRASS_START_Z_M);
    const side = patch % 2 === 0 ? -1 : 1;
    const offset = FLOWER_MIN_OFFSET_M + hash(patch * 5.7 + 901) * (GRASS_BAND_M - FLOWER_MIN_OFFSET_M);
    const centerX = field.getCorridorCenterX(z) + side * (field.getFairwayHalfWidth(z) + offset);
    for (let flower = 0; flower < FLOWERS_PER_PATCH; flower += 1) {
      const seed = patch * 31 + flower * 1.9 + 902;
      const x = centerX + (hash(seed) - 0.5) * 3;
      const flowerZ = z + (hash(seed + 0.5) - 0.5) * 3;
      if (field.getSurfaceWeights(x, flowerZ).rough > 0.9) {
        placements.push({ x, z: flowerZ, scale: 0.8 + hash(seed + 0.9) * 0.4 });
      }
    }
  }
  return placements;
};

/** Pond outline distance beyond which trees and bushes may grow. */
const POND_CLEARANCE = 1.45;
/** Extra gap kept either side of the cart path, metres. */
const CART_PATH_CLEARANCE_M = 2.5;

/** True where a plant would stand in the pond, on its bank, or on the cart path. */
const isBlocked = (field: FieldModel, x: number, z: number, pathClearanceM: number): boolean => {
  if (field.getFeatureDistance(x, z, field.pond) < POND_CLEARANCE) {
    return true;
  }
  const onPathStretch = z >= field.cartPathStartZ && z <= field.cartPathEndZ;
  return onPathStretch && Math.abs(x - field.getCartPathX(z)) < field.cartPathHalfWidthM + pathClearanceM;
};

const keepClear = (field: FieldModel, placements: Placement[], pathClearanceM: number): Placement[] =>
  placements.filter((placement) => !isBlocked(field, placement.x, placement.z, pathClearanceM));

/** Split placements between two model families by a seeded share. */
const splitByShare = (placements: Placement[], share: number, seed: number): [Placement[], Placement[]] => {
  const first: Placement[] = [];
  const second: Placement[] = [];
  placements.forEach((placement, index) => {
    (hash(index * 6.1 + seed) < share ? first : second).push(placement);
  });
  return [first, second];
};

/**
 * Load the vegetation models and plant the course. Runs after the scene is
 * already rendering; the trees simply pop in once their models arrive.
 */
export const populateVegetation = async (
  scene: Scene,
  field: FieldModel,
  material: Material,
  shadowGenerator: ShadowSystem | null,
  outsideFieldHeightAt: HeightResolver,
): Promise<void> => {
  const [broadleaf, conifer, bushes, grass, flowers] = await Promise.all([
    loadModels(scene, BROADLEAF_SPECS, material),
    loadModels(scene, CONIFER_SPECS, material),
    loadModels(scene, BUSH_SPECS, material),
    loadModels(scene, GRASS_SPECS, material),
    loadModels(scene, FLOWER_SPECS, material),
  ]);

  prepareInstanceSources([...broadleaf, ...conifer, ...bushes]);

  const corridorTrees = keepClear(
    field,
    [
      ...corridorTreePlacements(field, 35, 180, 18, 44, 0.85, 1.2, 0),
      ...corridorTreePlacements(field, 180, 300, 20, 52, 0.9, 1.25, 100),
    ],
    CART_PATH_CLEARANCE_M,
  );
  const [corridorConifers, corridorBroadleaf] = splitByShare(corridorTrees, CORRIDOR_CONIFER_SHARE, 11);
  placeInstances(broadleaf, corridorBroadleaf, BROADLEAF_HEIGHT_M, "tree-corridor", field.getHeight, shadowGenerator);
  placeInstances(conifer, corridorConifers, CONIFER_HEIGHT_M, "conifer-corridor", field.getHeight, shadowGenerator);
  placeInstances(bushes, keepClear(field, bushPlacements(field, corridorTrees), CART_PATH_CLEARANCE_M), BUSH_HEIGHT_M, "bush", field.getHeight, null);

  const [perimeterConifers, perimeterBroadleaf] = splitByShare(
    keepClear(field, perimeterTreePlacements(field), CART_PATH_CLEARANCE_M),
    PERIMETER_CONIFER_SHARE,
    23,
  );
  placeInstances(broadleaf, perimeterBroadleaf, BROADLEAF_HEIGHT_M, "tree-perimeter", outsideFieldHeightAt, null);
  placeInstances(conifer, perimeterConifers, CONIFER_HEIGHT_M, "conifer-perimeter", outsideFieldHeightAt, null);

  placeThinInstances(grass, keepClear(field, grassPlacements(field), 0.3), GRASS_HEIGHT_M, field.getHeight);
  placeThinInstances(flowers, keepClear(field, flowerPlacements(field), 0.5), FLOWER_HEIGHT_M, field.getHeight);
};
