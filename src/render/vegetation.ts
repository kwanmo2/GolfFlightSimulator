import {
  Color4,
  InstancedMesh,
  Matrix,
  Mesh,
  PBRMaterial,
  Quaternion,
  Scene,
  Vector3,
  VertexBuffer,
  VertexData,
} from "@babylonjs/core";
import type { AbstractMesh, Texture } from "@babylonjs/core";
import type { GraphicsQuality } from "../types/simulation";
import {
  composeGrassClump,
  composeLeafCluster,
  composeNeedleCluster,
  loadBarkTextures,
  loadFoliageAtlas,
} from "./foliageTextures";
import type { FoliageCard } from "./foliageTextures";
import { bakeImpostor } from "./impostor";
import type { ImpostorTemplate } from "./impostor";
import { hash, smoothstep, valueNoise } from "./proceduralNoise";
import { QUALITY_PRESETS } from "./renderConfig";
import type { ShadowSystem } from "./shadows";
import type { FieldModel } from "./terrain";
import { generateTree } from "./treeGenerator";
import type { GeneratedTree, TreeSpec } from "./treeGenerator";
import type { WaterController } from "./water";
import { WindPlugin } from "./windPlugin";
import type { WindResponse } from "./windPlugin";

export type HeightResolver = (x: number, z: number) => number;

export interface VegetationController {
  setQuality(quality: GraphicsQuality): void;
}

/** Everything near enough to the hole to throw a visible shadow. */
const SHADOW_CASTER_MAX_Z = 320;

/** Trees are planted slightly into the ground so no gap shows on slopes. */
const TREE_SINK_M = 0.15;
/** Share of corridor trees that are conifers. */
const CORRIDOR_CONIFER_SHARE = 0.3;
/** Share of the far forest that is conifers. */
const FOREST_CONIFER_SHARE = 0.45;

/** Per-instance brightness jitter so neighbouring copies of a tree differ. */
const TREE_TINT_RANGE = 0.16;
const GRASS_TINT_RANGE = 0.22;

// Rough grass is scattered on a jittered grid, thinned by noise into patches.
const GRASS_GRID_M = 1.4;
const GRASS_START_Z_M = 10;
const GRASS_END_Z_M = 300;
/** Lateral band beyond the fairway edge that gets grass. */
const GRASS_BAND_M = 42;
const GRASS_PATCH_SCALE = 0.07;
/** Chance of a clump at a grid point in the thickest part of a patch. */
const GRASS_MAX_DENSITY = 0.6;
/** Fairway-side margin where the grass thins out, so balls just offline stay visible. */
const GRASS_FAIRWAY_MARGIN_M = 5;
const BUNKER_LIP_TUFTS = 46;
/** Width and height of one grass clump card at scale 1, metres. */
const GRASS_CARD_M = 0.55;
/** Grass clump: crossed cards, each turned an equal share of a half turn from the last. */
const GRASS_CARD_COUNT = 3;
/** Ambient occlusion at the root of a grass clump. */
const GRASS_ROOT_SHADE = 0.55;

// The far forest: a jittered grid beyond the corridor trees, thinned by noise
// into stands and clearings, drawn entirely as impostors.
const FOREST_SPACING_M = 8;
/** Lateral distance from the corridor centre where the forest begins. */
const FOREST_INNER_M = 112;
const FOREST_OUTER_X_M = 320;
const FOREST_START_Z_M = -140;
const FOREST_END_Z_M = 450;
/** The forest closes in behind the green from here... */
const FOREST_BACK_Z_M = 328;
/** ...and behind the tee from here back. */
const FOREST_TEE_Z_M = -45;
const FOREST_STAND_SCALE = 0.018;
const FOREST_STAND_THRESHOLD = 0.32;

const LEAF_ALPHA_CUTOFF = 0.45;
const LEAF_ROUGHNESS = 0.85;
/**
 * Leaves reflect less than the default dielectric F0 of 0.04. With crown
 * normals bent away from the card, full F0 turns the grazing-angle tops of
 * crowns silvery.
 */
const LEAF_F0_FACTOR = 0.35;
const BARK_ROUGHNESS = 0.92;
const GRASS_ROUGHNESS = 0.85;
/**
 * Linear multiplier on the leaf photos: the scanned leaves are lit flat and
 * read too light and yellow once lit again by the sun and sky.
 */
const LEAF_TINT = { r: 0.72, g: 0.8, b: 0.7 };

const TREE_WIND: WindResponse = { swayM: 0.16, flutterM: 0.025, referenceHeightM: 12 };
const BUSH_WIND: WindResponse = { swayM: 0.05, flutterM: 0.02, referenceHeightM: 1.5 };
const GRASS_WIND: WindResponse = { swayM: 0.05, flutterM: 0.012, referenceHeightM: 0.5 };

type LeafKind = "oak" | "beech" | "linden" | "fir";

interface TreeVariant {
  leaves: LeafKind;
  spec: TreeSpec;
  seed: number;
}

const BROADLEAF_VARIANTS: TreeVariant[] = [
  {
    leaves: "oak",
    seed: 11,
    spec: { kind: "broadleaf", heightM: 12, trunkSplit: 0.32, trunkRadiusM: 0.32, limbCount: 6, limbElevation: [0.45, 0.95], limbLength: 0.42, twigsPerLimb: 6, cardsPerTwig: 5, fillCards: 70, cardSizeM: 2.0, crownAspect: 0.9 },
  },
  {
    leaves: "beech",
    seed: 23,
    spec: { kind: "broadleaf", heightM: 15, trunkSplit: 0.4, trunkRadiusM: 0.3, limbCount: 5, limbElevation: [0.7, 1.15], limbLength: 0.38, twigsPerLimb: 6, cardsPerTwig: 5, fillCards: 80, cardSizeM: 2.1, crownAspect: 1.15 },
  },
  {
    leaves: "linden",
    seed: 37,
    spec: { kind: "broadleaf", heightM: 13, trunkSplit: 0.35, trunkRadiusM: 0.28, limbCount: 5, limbElevation: [0.6, 1.05], limbLength: 0.4, twigsPerLimb: 6, cardsPerTwig: 5, fillCards: 70, cardSizeM: 1.9, crownAspect: 1.05 },
  },
  {
    leaves: "oak",
    seed: 41,
    spec: { kind: "broadleaf", heightM: 10.5, trunkSplit: 0.28, trunkRadiusM: 0.34, limbCount: 7, limbElevation: [0.35, 0.8], limbLength: 0.46, twigsPerLimb: 5, cardsPerTwig: 5, fillCards: 70, cardSizeM: 2.0, crownAspect: 0.8 },
  },
];

const CONIFER_VARIANTS: TreeVariant[] = [
  {
    leaves: "fir",
    seed: 53,
    spec: { kind: "conifer", heightM: 16, trunkRadiusM: 0.28, crownBase: 0.12, whorlSpacingM: 0.55, branchesPerWhorl: 6, maxBranchLengthM: 3.6, cardSizeM: 1.7 },
  },
  {
    leaves: "fir",
    seed: 67,
    spec: { kind: "conifer", heightM: 19, trunkRadiusM: 0.3, crownBase: 0.2, whorlSpacingM: 0.6, branchesPerWhorl: 5, maxBranchLengthM: 3.2, cardSizeM: 1.8 },
  },
];

const BUSH_VARIANTS: TreeVariant[] = [
  { leaves: "beech", seed: 71, spec: { kind: "bush", radiusM: 1.1, cards: 34, cardSizeM: 1.0 } },
  { leaves: "linden", seed: 83, spec: { kind: "bush", radiusM: 0.9, cards: 28, cardSizeM: 0.9 } },
];

interface Placement {
  x: number;
  z: number;
  /** Multiplier on the model's own size. */
  scale: number;
}

const tintFor = (seed: number, range: number): Color4 => {
  const shade = 1 - range / 2 + hash(seed) * range;
  return new Color4(shade, shade, shade, 1);
};

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

/**
 * The far forest beyond the corridor trees, on both sides, behind the green and
 * behind the tee, broken into stands and clearings by noise.
 */
const forestPlacements = (field: FieldModel): Placement[] => {
  const placements: Placement[] = [];
  let seed = 5000;
  for (let z = FOREST_START_Z_M; z < FOREST_END_Z_M; z += FOREST_SPACING_M) {
    const center = field.getCorridorCenterX(Math.min(Math.max(z, 0), field.holeLengthM));
    for (let x = -FOREST_OUTER_X_M; x < FOREST_OUTER_X_M; x += FOREST_SPACING_M) {
      seed += 1;
      const px = x + (hash(seed * 1.31) - 0.5) * FOREST_SPACING_M * 0.9;
      const pz = z + (hash(seed * 2.17) - 0.5) * FOREST_SPACING_M * 0.9;
      const inBand = Math.abs(px - center) > FOREST_INNER_M || pz > FOREST_BACK_Z_M || pz < FOREST_TEE_Z_M;
      if (!inBand) {
        continue;
      }
      const stand = valueNoise(px * FOREST_STAND_SCALE + 11.3, pz * FOREST_STAND_SCALE - 4.7);
      if (stand < FOREST_STAND_THRESHOLD || hash(seed * 3.7) > smoothstep(FOREST_STAND_THRESHOLD, 0.6, stand) + 0.15) {
        continue;
      }
      placements.push({ x: px, z: pz, scale: 0.8 + hash(seed * 4.9) * 0.5 });
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

/** Split placements between two families by a seeded share. */
const splitByShare = (placements: Placement[], share: number, seed: number): [Placement[], Placement[]] => {
  const first: Placement[] = [];
  const second: Placement[] = [];
  placements.forEach((placement, index) => {
    (hash(index * 6.1 + seed) < share ? first : second).push(placement);
  });
  return [first, second];
};

const createLeafMaterial = (scene: Scene, name: string, card: FoliageCard, wind: WindResponse): PBRMaterial => {
  const material = new PBRMaterial(name, scene);
  material.albedoTexture = card.texture;
  material.useAlphaFromAlbedoTexture = true;
  material.transparencyMode = PBRMaterial.PBRMATERIAL_ALPHATEST;
  material.alphaCutOff = LEAF_ALPHA_CUTOFF;
  material.metallic = 0;
  material.roughness = LEAF_ROUGHNESS;
  material.metallicF0Factor = LEAF_F0_FACTOR;
  // Both faces show, lit with the same bent crown normal (see treeGenerator.ts).
  material.backFaceCulling = false;
  material.twoSidedLighting = false;
  material.albedoColor.set(LEAF_TINT.r, LEAF_TINT.g, LEAF_TINT.b);
  new WindPlugin(material, wind);
  return material;
};

const createBarkMaterial = (scene: Scene, name: string, textures: { color: Texture; normal: Texture }): PBRMaterial => {
  const material = new PBRMaterial(name, scene);
  material.albedoTexture = textures.color;
  material.bumpTexture = textures.normal;
  material.metallic = 0;
  material.roughness = BARK_ROUGHNESS;
  material.backFaceCulling = false;
  new WindPlugin(material, TREE_WIND);
  return material;
};

/** Hide an instance source and give it a per-instance tint buffer. Call once per source. */
const prepareInstanceSource = (source: Mesh): void => {
  // Classic instances share their source's buffers by kind, so a tint
  // registered as "color" would replace the per-vertex crown occlusion. The
  // instance kind multiplies with it instead.
  source.registerInstancedBuffer(VertexBuffer.ColorInstanceKind, 4);
  source.instancedBuffers[VertexBuffer.ColorInstanceKind] = new Color4(1, 1, 1, 1);
  source.isVisible = false;
};

/** Full-geometry instances, picking a tree per placement. */
const placeTrees = (
  trees: GeneratedTree[],
  placements: Placement[],
  namePrefix: string,
  heightAt: HeightResolver,
  shadows: ShadowSystem | null,
): InstancedMesh[] =>
  placements.map((placement, index) => {
    const source = trees[Math.floor(hash(placement.x * 0.37 + placement.z * 0.11) * trees.length)].mesh;
    const instance = source.createInstance(`${namePrefix}-${index}`);
    const scale = placement.scale;
    instance.position.set(placement.x, heightAt(placement.x, placement.z) - TREE_SINK_M, placement.z);
    instance.rotation.y = hash(index * 3.3 + 0.5) * Math.PI * 2;
    instance.scaling.set(scale, scale * (0.92 + hash(index * 1.9) * 0.16), scale);
    instance.instancedBuffers[VertexBuffer.ColorInstanceKind] = tintFor(index * 4.3 + 0.7, TREE_TINT_RANGE);
    instance.isPickable = false;
    if (shadows && placement.z < SHADOW_CASTER_MAX_Z) {
      shadows.addShadowCaster(instance);
    }
    return instance;
  });

/** Impostor copies as thin instances: one draw call per tree variant. */
const placeImpostors = (templates: ImpostorTemplate[], placements: Placement[], heightAt: HeightResolver): void => {
  const buckets = templates.map(() => ({ matrices: [] as number[], colors: [] as number[] }));
  placements.forEach((placement, index) => {
    const which = Math.floor(hash(placement.x * 0.23 + placement.z * 0.41 + 7) * templates.length);
    const template = templates[which];
    const scale = placement.scale;
    const matrix = Matrix.Compose(
      new Vector3(template.widthM * scale, template.heightM * scale, template.widthM * scale),
      Quaternion.RotationAxis(Vector3.Up(), hash(index * 0.77 + 0.3) * Math.PI * 2),
      new Vector3(placement.x, heightAt(placement.x, placement.z) - TREE_SINK_M, placement.z),
    );
    buckets[which].matrices.push(...matrix.toArray());
    const tint = tintFor(index * 2.7 + 0.1, TREE_TINT_RANGE);
    buckets[which].colors.push(tint.r, tint.g, tint.b, 1);
  });
  templates.forEach((template, index) => {
    const { matrices, colors } = buckets[index];
    if (matrices.length === 0) {
      template.mesh.setEnabled(false);
      return;
    }
    template.mesh.thinInstanceSetBuffer("matrix", new Float32Array(matrices), 16, true);
    template.mesh.thinInstanceSetBuffer("color", new Float32Array(colors), 4, true);
  });
};

/** A grass clump: crossed cards standing on y = 0, with upward normals so it lights like the turf around it. */
const createGrassClumpMesh = (scene: Scene, material: PBRMaterial): Mesh => {
  const positions: number[] = [];
  const normals: number[] = [];
  const uvs: number[] = [];
  const colors: number[] = [];
  const indices: number[] = [];
  for (let card = 0; card < GRASS_CARD_COUNT; card += 1) {
    const angle = (card / GRASS_CARD_COUNT) * Math.PI;
    const dx = Math.cos(angle) * 0.5;
    const dz = Math.sin(angle) * 0.5;
    const first = positions.length / 3;
    positions.push(-dx, 0, -dz, dx, 0, dz, -dx, 1, -dz, dx, 1, dz);
    for (let corner = 0; corner < 4; corner += 1) {
      normals.push(0, 1, 0);
      const shade = corner >= 2 ? 1 : GRASS_ROOT_SHADE;
      colors.push(shade, shade, shade, 1);
    }
    uvs.push(0, 0, 1, 0, 0, 1, 1, 1);
    indices.push(first, first + 2, first + 1, first + 1, first + 2, first + 3);
  }
  const data = new VertexData();
  data.positions = positions;
  data.normals = normals;
  data.uvs = uvs;
  data.colors = colors;
  data.indices = indices;
  const mesh = new Mesh("grass-clump", scene);
  data.applyToMesh(mesh);
  mesh.material = material;
  mesh.isPickable = false;
  mesh.receiveShadows = true;
  mesh.alwaysSelectAsActiveMesh = true;
  return mesh;
};

/**
 * Grass clumps as thin instances. Placements are shuffled first, so a lower
 * quality preset can draw a random subset just by lowering thinInstanceCount.
 */
const placeGrass = (mesh: Mesh, placements: Placement[], heightAt: HeightResolver): number => {
  const shuffled = placements
    .map((placement, index) => ({ placement, order: hash(index * 7.13 + 0.37) }))
    .sort((a, b) => a.order - b.order)
    .map(({ placement }) => placement);
  const matrices: number[] = [];
  const colors: number[] = [];
  shuffled.forEach((placement, index) => {
    const size = GRASS_CARD_M * placement.scale;
    const matrix = Matrix.Compose(
      new Vector3(size, size * (0.8 + hash(index * 0.53) * 0.4), size),
      Quaternion.RotationAxis(Vector3.Up(), hash(index * 0.7 + 0.5) * Math.PI * 2),
      new Vector3(placement.x, heightAt(placement.x, placement.z) - 0.02, placement.z),
    );
    matrices.push(...matrix.toArray());
    const tint = tintFor(index * 2.1 + 0.9, GRASS_TINT_RANGE);
    colors.push(tint.r, tint.g, tint.b, 1);
  });
  mesh.thinInstanceSetBuffer("matrix", new Float32Array(matrices), 16, true);
  mesh.thinInstanceSetBuffer("color", new Float32Array(colors), 4, true);
  return shuffled.length;
};

/**
 * Grow and plant the course's vegetation. Runs after the scene is already
 * rendering; trees and grass pop in once their textures are composed, and the
 * far forest once its impostors are baked.
 */
export const populateVegetation = async (
  scene: Scene,
  field: FieldModel,
  shadows: ShadowSystem | null,
  outsideFieldHeightAt: HeightResolver,
  water: WaterController,
  initialQuality: GraphicsQuality,
): Promise<VegetationController> => {
  const atlases = await Promise.all([
    loadFoliageAtlas("oak"),
    loadFoliageAtlas("beech"),
    loadFoliageAtlas("linden"),
    loadFoliageAtlas("fir"),
    loadFoliageAtlas("grass"),
    loadFoliageAtlas("weeds"),
  ]);
  const [oakAtlas, beechAtlas, lindenAtlas, firAtlas, grassAtlas, weedsAtlas] = atlases;
  const cards: Record<LeafKind, FoliageCard> = {
    oak: composeLeafCluster(scene, "oak-cluster", oakAtlas, 101),
    beech: composeLeafCluster(scene, "beech-cluster", beechAtlas, 202),
    linden: composeLeafCluster(scene, "linden-cluster", lindenAtlas, 303),
    fir: composeNeedleCluster(scene, "fir-cluster", firAtlas, 404),
  };
  const grassCard = composeGrassClump(scene, "grass-clump-card", grassAtlas, weedsAtlas, 505);
  atlases.forEach((atlas) => atlas.image.close());

  const leafMaterials = new Map<LeafKind, PBRMaterial>();
  const leafMaterial = (kind: LeafKind): PBRMaterial => {
    let material = leafMaterials.get(kind);
    if (!material) {
      material = createLeafMaterial(scene, `${kind}-leaf-material`, cards[kind], TREE_WIND);
      leafMaterials.set(kind, material);
    }
    return material;
  };
  const broadleafBark = createBarkMaterial(scene, "broadleaf-bark-material", loadBarkTextures(scene, "broadleaf"));
  const coniferBark = createBarkMaterial(scene, "conifer-bark-material", loadBarkTextures(scene, "conifer"));

  const grow = (variant: TreeVariant, name: string, bark: PBRMaterial, leaves: PBRMaterial): GeneratedTree => {
    const tree = generateTree(scene, name, variant.spec, variant.seed, bark, leaves);
    prepareInstanceSource(tree.mesh);
    return tree;
  };
  const broadleaf = BROADLEAF_VARIANTS.map((variant, index) =>
    grow(variant, `broadleaf-${index}`, broadleafBark, leafMaterial(variant.leaves)),
  );
  const conifers = CONIFER_VARIANTS.map((variant, index) =>
    grow(variant, `conifer-${index}`, coniferBark, leafMaterial(variant.leaves)),
  );
  const bushes = BUSH_VARIANTS.map((variant, index) =>
    grow(
      variant,
      `bush-${index}`,
      broadleafBark,
      createLeafMaterial(scene, `bush-leaf-material-${index}`, cards[variant.leaves], BUSH_WIND),
    ),
  );

  const corridorTrees = keepClear(
    field,
    [
      ...corridorTreePlacements(field, 35, 180, 18, 44, 0.85, 1.15, 0),
      ...corridorTreePlacements(field, 180, 300, 20, 52, 0.9, 1.2, 100),
    ],
    CART_PATH_CLEARANCE_M,
  );
  const [corridorConifers, corridorBroadleaf] = splitByShare(corridorTrees, CORRIDOR_CONIFER_SHARE, 11);
  const reflected: AbstractMesh[] = [
    ...placeTrees(broadleaf, corridorBroadleaf, "tree-corridor", field.getHeight, shadows),
    ...placeTrees(conifers, corridorConifers, "conifer-corridor", field.getHeight, shadows),
  ];
  placeTrees(bushes, keepClear(field, bushPlacements(field, corridorTrees), CART_PATH_CLEARANCE_M), "bush", field.getHeight, null);

  const grassMaterial = createLeafMaterial(scene, "grass-clump-material", grassCard, GRASS_WIND);
  grassMaterial.roughness = GRASS_ROUGHNESS;
  const grassMesh = createGrassClumpMesh(scene, grassMaterial);
  const grassCount = placeGrass(grassMesh, keepClear(field, grassPlacements(field), 0.3), field.getHeight);

  const applyQuality = (quality: GraphicsQuality): void => {
    grassMesh.thinInstanceCount = Math.round(grassCount * QUALITY_PRESETS[quality].grassDensity);
  };
  applyQuality(initialQuality);

  // Far forest: photograph each tree variant once, then plant thousands of copies.
  const broadleafImpostors: ImpostorTemplate[] = [];
  for (const [index, tree] of broadleaf.entries()) {
    broadleafImpostors.push(await bakeImpostor(scene, `broadleaf-${index}`, tree, cards[BROADLEAF_VARIANTS[index].leaves].meanColor));
  }
  const coniferImpostors: ImpostorTemplate[] = [];
  for (const [index, tree] of conifers.entries()) {
    coniferImpostors.push(await bakeImpostor(scene, `conifer-${index}`, tree, cards.fir.meanColor));
  }
  const [forestConifers, forestBroadleaf] = splitByShare(
    keepClear(field, forestPlacements(field), CART_PATH_CLEARANCE_M),
    FOREST_CONIFER_SHARE,
    29,
  );
  placeImpostors(broadleafImpostors, forestBroadleaf, outsideFieldHeightAt);
  placeImpostors(coniferImpostors, forestConifers, outsideFieldHeightAt);
  reflected.push(...broadleafImpostors.map((template) => template.mesh), ...coniferImpostors.map((template) => template.mesh));
  water.addReflectedMeshes(reflected);

  return { setQuality: applyQuality };
};
