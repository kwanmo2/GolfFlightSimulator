import { Mesh, MultiMaterial, SubMesh, Vector3, VertexData } from "@babylonjs/core";
import type { Material, Scene } from "@babylonjs/core";
import { clamp01, mulberry32 } from "./proceduralNoise";

/**
 * Procedural trees built from photographic parts: tapered bark tubes for the
 * trunk and limbs, and a few hundred alpha-tested leaf-cluster cards (see
 * foliageTextures.ts) for the crown. Every tree is generated from a seed, so
 * the course grows the same trees on every load.
 *
 * Leaf card normals are bent toward "away from the crown centre", which makes
 * the crown shade as one soft volume (lit side, shadow side) instead of a
 * confetti of flat cards; this is the standard trick for real-time foliage.
 */

type Random = () => number;

export interface BroadleafSpec {
  kind: "broadleaf";
  heightM: number;
  /** Fraction of the height where the trunk splits into limbs. */
  trunkSplit: number;
  trunkRadiusM: number;
  limbCount: number;
  /** Limb elevation range, radians above horizontal. */
  limbElevation: [number, number];
  /** Limb length as a fraction of the tree height. */
  limbLength: number;
  twigsPerLimb: number;
  cardsPerTwig: number;
  /** Extra cards filling the crown volume. */
  fillCards: number;
  cardSizeM: number;
  /** Squashes the crown vertically (<1) or stretches it (>1). */
  crownAspect: number;
}

export interface ConiferSpec {
  kind: "conifer";
  heightM: number;
  trunkRadiusM: number;
  /** Fraction of the height where the lowest branches start. */
  crownBase: number;
  whorlSpacingM: number;
  branchesPerWhorl: number;
  maxBranchLengthM: number;
  cardSizeM: number;
}

export interface BushSpec {
  kind: "bush";
  radiusM: number;
  cards: number;
  cardSizeM: number;
}

export type TreeSpec = BroadleafSpec | ConiferSpec | BushSpec;

export interface GeneratedTree {
  mesh: Mesh;
  heightM: number;
  /** Largest horizontal distance of the crown from the trunk. */
  radiusM: number;
}

/** World size of one bark texture repeat, metres. */
const BARK_TILE_M = 1.2;
/** How far card normals bend toward the crown-volume normal (0 = flat cards). */
const CROWN_NORMAL_BLEND = 0.78;
/** Darkest ambient occlusion deep inside a crown. */
const CROWN_AO_MIN = 0.42;
const TRUNK_SIDES = 8;
const LIMB_SIDES = 6;
const TWIG_SIDES = 4;

class GeometryBuffer {
  public readonly positions: number[] = [];
  public readonly normals: number[] = [];
  public readonly uvs: number[] = [];
  public readonly colors: number[] = [];
  public readonly indices: number[] = [];

  public get vertexCount(): number {
    return this.positions.length / 3;
  }

  public addVertex(position: Vector3, normal: Vector3, u: number, v: number, shade: number): number {
    this.positions.push(position.x, position.y, position.z);
    this.normals.push(normal.x, normal.y, normal.z);
    this.uvs.push(u, v);
    this.colors.push(shade, shade, shade, 1);
    return this.vertexCount - 1;
  }
}

const UP = new Vector3(0, 1, 0);

/** Any unit vector perpendicular to `axis`. */
const perpendicular = (axis: Vector3): Vector3 => {
  const helper = Math.abs(axis.y) < 0.9 ? UP : new Vector3(1, 0, 0);
  return Vector3.Cross(axis, helper).normalize();
};

const randomUnit = (random: Random): Vector3 => {
  const z = random() * 2 - 1;
  const angle = random() * Math.PI * 2;
  const r = Math.sqrt(1 - z * z);
  return new Vector3(r * Math.cos(angle), z, r * Math.sin(angle));
};

const range = (random: Random, min: number, max: number): number => min + (max - min) * random();

/** A tapered tube along a polyline, bark-mapped. */
const addTube = (
  buffer: GeometryBuffer,
  path: Vector3[],
  radii: number[],
  sides: number,
  shadeAt: (point: Vector3) => number,
): void => {
  const circumference = Math.PI * 2 * radii[0];
  const uRepeats = Math.max(1, Math.round(circumference / BARK_TILE_M));
  let travelled = 0;
  let previousRing = -1;
  let side = perpendicular(path[1].subtract(path[0]).normalize());
  for (let ring = 0; ring < path.length; ring += 1) {
    const ahead = path[Math.min(ring + 1, path.length - 1)];
    const behind = path[Math.max(ring - 1, 0)];
    const axis = ahead.subtract(behind).normalize();
    // Re-orthogonalise the previous side vector so the tube does not twist.
    side = side.subtract(axis.scale(Vector3.Dot(side, axis))).normalize();
    const other = Vector3.Cross(axis, side);
    if (ring > 0) {
      travelled += Vector3.Distance(path[ring], path[ring - 1]);
    }
    const first = buffer.vertexCount;
    for (let index = 0; index <= sides; index += 1) {
      const angle = (index / sides) * Math.PI * 2;
      const normal = side.scale(Math.cos(angle)).add(other.scale(Math.sin(angle)));
      const position = path[ring].add(normal.scale(radii[ring]));
      buffer.addVertex(position, normal, (index / sides) * uRepeats, travelled / BARK_TILE_M, shadeAt(position));
    }
    if (previousRing >= 0) {
      for (let index = 0; index < sides; index += 1) {
        const a = previousRing + index;
        const b = previousRing + index + 1;
        const c = first + index;
        const d = first + index + 1;
        buffer.indices.push(a, c, b, b, c, d);
      }
    }
    previousRing = first;
  }
};

/**
 * A grown branch: starts at `start`, heads along `direction` and bends a
 * little each segment (toward the light, or drooping when `tropism` < 0).
 */
const growPath = (
  random: Random,
  start: Vector3,
  direction: Vector3,
  length: number,
  segments: number,
  tropism: number,
  wander: number,
): Vector3[] => {
  const path = [start.clone()];
  let heading = direction.clone().normalize();
  const step = length / segments;
  for (let segment = 0; segment < segments; segment += 1) {
    heading = heading.add(UP.scale(tropism)).add(randomUnit(random).scale(wander)).normalize();
    path.push(path[path.length - 1].add(heading.scale(step)));
  }
  return path;
};

const pointAlong = (path: Vector3[], t: number): Vector3 => {
  const scaled = clamp01(t) * (path.length - 1);
  const index = Math.min(Math.floor(scaled), path.length - 2);
  return Vector3.Lerp(path[index], path[index + 1], scaled - index);
};

const directionAlong = (path: Vector3[], t: number): Vector3 => {
  const index = Math.min(Math.floor(clamp01(t) * (path.length - 1)), path.length - 2);
  return path[index + 1].subtract(path[index]).normalize();
};

interface Crown {
  center: Vector3;
  /** Half extents of the crown ellipsoid. */
  radii: Vector3;
}

/**
 * A leaf card rooted at `base`, growing along `up`, facing `facing`. Its
 * corners take crown-volume normals and ambient occlusion from `crown`.
 */
const addCard = (
  buffer: GeometryBuffer,
  crown: Crown,
  base: Vector3,
  up: Vector3,
  facing: Vector3,
  width: number,
  height: number,
  mirror: boolean,
  crownNormal: (point: Vector3) => Vector3,
): void => {
  const along = up.normalize();
  const side = Vector3.Cross(along, facing).normalize();
  const cardNormal = Vector3.Cross(side, along).normalize();
  const corners: Array<[Vector3, number, number]> = [
    [base.add(side.scale(-width / 2)), 0, 0],
    [base.add(side.scale(width / 2)), 1, 0],
    [base.add(side.scale(-width / 2)).add(along.scale(height)), 0, 1],
    [base.add(side.scale(width / 2)).add(along.scale(height)), 1, 1],
  ];
  const first = buffer.vertexCount;
  corners.forEach(([position, u, v]) => {
    const normal = Vector3.Lerp(cardNormal, crownNormal(position), CROWN_NORMAL_BLEND).normalize();
    const offset = position.subtract(crown.center);
    const depth = Math.sqrt(
      (offset.x / crown.radii.x) ** 2 + (offset.y / crown.radii.y) ** 2 + (offset.z / crown.radii.z) ** 2,
    );
    const heightShade = clamp01((position.y - (crown.center.y - crown.radii.y)) / (crown.radii.y * 2));
    const shade = CROWN_AO_MIN + (1 - CROWN_AO_MIN) * clamp01(depth) ** 0.8 * (0.8 + 0.2 * heightShade);
    buffer.addVertex(position, normal, mirror ? 1 - u : u, v, shade);
  });
  buffer.indices.push(first, first + 2, first + 1, first + 1, first + 2, first + 3);
};

const ellipsoidNormal = (crown: Crown) => (point: Vector3): Vector3 => {
  const offset = point.subtract(crown.center);
  return new Vector3(
    offset.x / (crown.radii.x * crown.radii.x),
    offset.y / (crown.radii.y * crown.radii.y),
    offset.z / (crown.radii.z * crown.radii.z),
  ).normalize();
};

/** Bark is a touch darker near the ground, where grass and soil shade it. */
const barkShade = (heightM: number) => (point: Vector3): number => 0.7 + 0.3 * clamp01(point.y / (heightM * 0.3));

const growBroadleaf = (spec: BroadleafSpec, random: Random, bark: GeometryBuffer, leaves: GeometryBuffer): void => {
  const height = spec.heightM;
  const trunkTop = height * spec.trunkSplit;
  const shade = barkShade(height);
  const lean = new Vector3(range(random, -0.08, 0.08), 1, range(random, -0.08, 0.08));
  const trunk = growPath(random, Vector3.Zero(), lean, trunkTop, 4, 0, 0.03);
  addTube(bark, trunk, [spec.trunkRadiusM * 1.25, spec.trunkRadiusM, spec.trunkRadiusM * 0.85, spec.trunkRadiusM * 0.78, spec.trunkRadiusM * 0.72], TRUNK_SIDES, shade);

  interface Twig {
    path: Vector3[];
  }
  const twigs: Twig[] = [];
  const limbRadius = spec.trunkRadiusM * 0.55;
  for (let limb = 0; limb < spec.limbCount; limb += 1) {
    const azimuth = (limb / spec.limbCount) * Math.PI * 2 + range(random, -0.4, 0.4);
    const leader = limb === 0;
    const elevation = leader ? range(random, 1.25, 1.45) : range(random, spec.limbElevation[0], spec.limbElevation[1]);
    const direction = new Vector3(
      Math.cos(elevation) * Math.cos(azimuth),
      Math.sin(elevation),
      Math.cos(elevation) * Math.sin(azimuth),
    );
    const start = pointAlong(trunk, range(random, 0.78, 1));
    const length = height * spec.limbLength * range(random, 0.85, 1.15) * (leader ? 1.1 : 1);
    const path = growPath(random, start, direction, length, 4, 0.1, 0.08);
    addTube(bark, path, [limbRadius, limbRadius * 0.75, limbRadius * 0.55, limbRadius * 0.38, limbRadius * 0.22], LIMB_SIDES, shade);

    for (let twig = 0; twig < spec.twigsPerLimb; twig += 1) {
      const t = range(random, 0.35, 1);
      const twigStart = pointAlong(path, t);
      const limbDirection = directionAlong(path, t);
      const outward = perpendicular(limbDirection);
      const spin = random() * Math.PI * 2;
      const sideways = outward.scale(Math.cos(spin)).add(Vector3.Cross(limbDirection, outward).scale(Math.sin(spin)));
      const twigDirection = limbDirection.scale(0.6).add(sideways.scale(0.8)).add(UP.scale(0.25)).normalize();
      const twigPath = growPath(random, twigStart, twigDirection, length * range(random, 0.4, 0.6), 2, 0.08, 0.1);
      const twigRadius = limbRadius * 0.35 * (1.2 - t * 0.6);
      addTube(bark, twigPath, [twigRadius, twigRadius * 0.6, twigRadius * 0.25], TWIG_SIDES, shade);
      twigs.push({ path: twigPath });
    }
  }

  // The crown is the ellipsoid around the twig tips.
  const tips = twigs.flatMap((twig) => [twig.path[1], twig.path[twig.path.length - 1]]);
  const min = tips.reduce((acc, p) => Vector3.Minimize(acc, p), tips[0].clone());
  const max = tips.reduce((acc, p) => Vector3.Maximize(acc, p), tips[0].clone());
  const center = Vector3.Center(min, max);
  const crown: Crown = {
    center,
    radii: new Vector3(
      Math.max(1, (max.x - min.x) / 2 + spec.cardSizeM * 0.3),
      Math.max(1, ((max.y - min.y) / 2 + spec.cardSizeM * 0.3) * spec.crownAspect),
      Math.max(1, (max.z - min.z) / 2 + spec.cardSizeM * 0.3),
    ),
  };
  const crownNormal = ellipsoidNormal(crown);

  const addLeafCard = (base: Vector3, growth: Vector3): void => {
    const up = growth.add(randomUnit(random).scale(0.55)).add(UP.scale(0.3)).normalize();
    const size = spec.cardSizeM * range(random, 0.8, 1.2);
    addCard(leaves, crown, base, up, randomUnit(random), size, size, random() < 0.5, crownNormal);
  };
  twigs.forEach((twig) => {
    for (let card = 0; card < spec.cardsPerTwig; card += 1) {
      const t = range(random, 0.25, 1);
      const base = pointAlong(twig.path, t).add(randomUnit(random).scale(0.25));
      addLeafCard(base, directionAlong(twig.path, t));
    }
  });
  for (let card = 0; card < spec.fillCards; card += 1) {
    const direction = randomUnit(random);
    if (direction.y < -0.55) {
      direction.y *= 0.3;
    }
    const r = range(random, 0.5, 0.9);
    const base = crown.center.add(
      new Vector3(direction.x * crown.radii.x, direction.y * crown.radii.y, direction.z * crown.radii.z).scale(r),
    );
    addLeafCard(base, crownNormal(base));
  }
};

const growConifer = (spec: ConiferSpec, random: Random, bark: GeometryBuffer, leaves: GeometryBuffer): void => {
  const height = spec.heightM;
  const shade = barkShade(height);
  const trunk = growPath(random, Vector3.Zero(), new Vector3(range(random, -0.03, 0.03), 1, range(random, -0.03, 0.03)), height, 6, 0, 0.01);
  addTube(
    bark,
    trunk,
    trunk.map((_, index) => spec.trunkRadiusM * (1.15 - index / (trunk.length - 1)) + 0.015),
    TRUNK_SIDES,
    shade,
  );

  const crownBottom = height * spec.crownBase;
  const crown: Crown = {
    center: new Vector3(0, (crownBottom + height) / 2, 0),
    radii: new Vector3(spec.maxBranchLengthM + 0.5, (height - crownBottom) / 2 + 0.5, spec.maxBranchLengthM + 0.5),
  };
  // Cone normals: outward from the trunk, tipped up by the cone's slope.
  const slope = spec.maxBranchLengthM / (height - crownBottom);
  const coneNormal = (point: Vector3): Vector3 => {
    const radial = new Vector3(point.x, 0, point.z);
    const length = radial.length() || 1;
    return radial.scale(1 / length).add(UP.scale(slope + 0.25)).normalize();
  };

  let whorl = 0;
  for (let y = crownBottom; y < height * 0.96; y += spec.whorlSpacingM * range(random, 0.85, 1.15)) {
    const crownT = (y - crownBottom) / (height - crownBottom);
    const length = spec.maxBranchLengthM * (1 - crownT) ** 0.85 + 0.3;
    const droop = 0.25 - crownT * 0.45;
    for (let branch = 0; branch < spec.branchesPerWhorl; branch += 1) {
      const azimuth = whorl * 2.399 + (branch / spec.branchesPerWhorl) * Math.PI * 2 + range(random, -0.25, 0.25);
      const elevation = -droop + range(random, -0.12, 0.12);
      const direction = new Vector3(Math.cos(azimuth) * Math.cos(elevation), Math.sin(elevation), Math.sin(azimuth) * Math.cos(elevation));
      const start = new Vector3(0, y, 0).add(pointAlong(trunk, y / height).multiplyByFloats(1, 0, 1));
      const path = growPath(random, start, direction, length, 2, -0.12, 0.05);
      if (length > 1.4) {
        const radius = spec.trunkRadiusM * 0.25 * (length / spec.maxBranchLengthM) + 0.012;
        addTube(bark, path, [radius, radius * 0.6, radius * 0.25], 3, shade);
      }
      const cards = Math.max(1, Math.round(length / (spec.cardSizeM * 0.55)));
      for (let card = 0; card < cards; card += 1) {
        const t = cards === 1 ? 0.15 : 0.05 + (card / cards) * 0.75;
        const base = pointAlong(path, t);
        const along = directionAlong(path, t);
        // Sprays lie roughly flat, tilted a little around the branch.
        const flat = perpendicular(along);
        const tilt = range(random, -0.5, 0.5);
        const facing = UP.scale(Math.cos(tilt)).add(flat.scale(Math.sin(tilt))).normalize();
        const size = spec.cardSizeM * range(random, 0.8, 1.15) * (0.75 + 0.35 * (1 - crownT));
        addCard(leaves, crown, base, along, facing, size, size, random() < 0.5, coneNormal);
      }
    }
    whorl += 1;
  }
  // Leader at the very top.
  for (let card = 0; card < 3; card += 1) {
    const facing = new Vector3(Math.cos(card * 2.1), 0, Math.sin(card * 2.1));
    addCard(leaves, crown, new Vector3(0, height * 0.9, 0), UP, facing, spec.cardSizeM * 0.6, spec.cardSizeM * 0.6, false, coneNormal);
  }
};

const growBush = (spec: BushSpec, random: Random, leaves: GeometryBuffer): void => {
  const crown: Crown = {
    center: new Vector3(0, spec.radiusM * 0.55, 0),
    radii: new Vector3(spec.radiusM, spec.radiusM * 0.7, spec.radiusM),
  };
  const crownNormal = ellipsoidNormal(crown);
  for (let card = 0; card < spec.cards; card += 1) {
    const direction = randomUnit(random);
    direction.y = Math.abs(direction.y) * 0.8 - 0.1;
    const base = crown.center.add(
      new Vector3(direction.x * crown.radii.x, direction.y * crown.radii.y, direction.z * crown.radii.z).scale(range(random, 0.3, 0.85)),
    );
    const up = crownNormal(base).add(UP.scale(0.6)).add(randomUnit(random).scale(0.4)).normalize();
    const size = spec.cardSizeM * range(random, 0.8, 1.2);
    addCard(leaves, crown, base, up, randomUnit(random), size, size, random() < 0.5, crownNormal);
  }
};

const toVertexData = (bark: GeometryBuffer, leaves: GeometryBuffer): VertexData => {
  const data = new VertexData();
  const offset = bark.vertexCount;
  data.positions = [...bark.positions, ...leaves.positions];
  data.normals = [...bark.normals, ...leaves.normals];
  data.uvs = [...bark.uvs, ...leaves.uvs];
  data.colors = [...bark.colors, ...leaves.colors];
  data.indices = [...bark.indices, ...leaves.indices.map((index) => index + offset)];
  return data;
};

/**
 * Grow one tree as a single mesh with two submeshes: bark (material 0) and
 * leaves (material 1). The mesh stands on y = 0 at its own origin, in metres.
 */
export const generateTree = (
  scene: Scene,
  name: string,
  spec: TreeSpec,
  seed: number,
  barkMaterial: Material,
  leafMaterial: Material,
): GeneratedTree => {
  const random = mulberry32(seed);
  const bark = new GeometryBuffer();
  const leaves = new GeometryBuffer();
  if (spec.kind === "broadleaf") {
    growBroadleaf(spec, random, bark, leaves);
  } else if (spec.kind === "conifer") {
    growConifer(spec, random, bark, leaves);
  } else {
    growBush(spec, random, leaves);
  }

  const mesh = new Mesh(name, scene);
  toVertexData(bark, leaves).applyToMesh(mesh);
  mesh.subMeshes = [];
  const barkIndexCount = bark.indices.length;
  if (barkIndexCount > 0) {
    new SubMesh(0, 0, bark.vertexCount, 0, barkIndexCount, mesh);
  }
  new SubMesh(1, bark.vertexCount, leaves.vertexCount, barkIndexCount, leaves.indices.length, mesh);
  const materials = new MultiMaterial(`${name}-materials`, scene);
  materials.subMaterials.push(barkMaterial, leafMaterial);
  mesh.material = materials;
  mesh.isPickable = false;

  mesh.refreshBoundingInfo();
  const { minimum, maximum } = mesh.getBoundingInfo().boundingBox;
  const radiusM = Math.max(-minimum.x, maximum.x, -minimum.z, maximum.z);
  return { mesh, heightM: maximum.y, radiusM };
};
