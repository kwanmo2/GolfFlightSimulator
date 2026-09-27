import { Mesh, Scene, VertexData } from "@babylonjs/core";
import type { SurfaceType } from "../types/simulation";

export interface SurfaceWeights {
  tee: number;
  fairway: number;
  rough: number;
  green: number;
  bunker: number;
  fringe: number;
}

export interface CourseFeature {
  centerX: number;
  centerZ: number;
  radiusX: number;
  radiusZ: number;
  angleRad: number;
}

export interface FieldModel {
  terrainWidthM: number;
  terrainLengthM: number;
  holeLengthM: number;
  green: CourseFeature;
  bunkers: CourseFeature[];
  getHeight(x: number, z: number): number;
  /** Height of the gently rolling ground with no course features applied. */
  getBaseHeight(x: number, z: number): number;
  getSurfaceWeights(x: number, z: number): SurfaceWeights;
  getSurfaceType(x: number, z: number): SurfaceType;
  getCorridorCenterX(z: number): number;
  getFairwayHalfWidth(z: number): number;
  /** Normalised elliptical distance to a feature: 1 on its outline, 0 at its centre. */
  getFeatureDistance(x: number, z: number, feature: CourseFeature): number;
}

// Terrain height is purely visual: the physics ground stays the y = 0 plane
// (see core/collision.ts). Everything here is kept within about +-1.5 m so the
// visual offset applied by the renderers never reads as the ball floating.
const TERRAIN_WIDTH_M = 540;
const TERRAIN_LENGTH_M = 660;
const HOLE_LENGTH_M = 280;

const TEE_HEIGHT_M = 0.06;
const GREEN_HEIGHT_M = 0.1;
const GREEN_UNDULATION_M = 0.05;
const GREEN_TILT_PER_M = -0.005;
const BUNKER_DEPTH_M = 1.0;
const BUNKER_LIP_OUTER_M = 0.05;
const BUNKER_LIP_GREEN_SIDE_M = 0.16;

// Grid spacing (m): dense around the tee and the green complex, coarse outside.
const FINE_SPACING_M = 0.9;
const CORRIDOR_SPACING_M = 2.2;
const OUTSKIRT_SPACING_M = 6;

const clamp01 = (value: number): number => Math.max(0, Math.min(1, value));

const smoothstep = (edge0: number, edge1: number, value: number): number => {
  const t = clamp01((value - edge0) / (edge1 - edge0));
  return t * t * (3 - 2 * t);
};

const inverseSmoothBand = (distance: number, radius: number, falloff: number): number =>
  1 - smoothstep(radius, radius + falloff, distance);

const ellipseDistance = (
  x: number,
  z: number,
  feature: CourseFeature,
): number => {
  const translatedX = x - feature.centerX;
  const translatedZ = z - feature.centerZ;
  const cos = Math.cos(feature.angleRad);
  const sin = Math.sin(feature.angleRad);
  const localX = translatedX * cos + translatedZ * sin;
  const localZ = -translatedX * sin + translatedZ * cos;

  return Math.sqrt(
    (localX * localX) / (feature.radiusX * feature.radiusX) +
      (localZ * localZ) / (feature.radiusZ * feature.radiusZ),
  );
};

const corridorCenterX = (z: number): number =>
  Math.sin((z - 32) * 0.012) * 7 +
  Math.sin((z + 18) * 0.028) * 2.4;

const fairwayHalfWidth = (z: number): number =>
  26 -
  smoothstep(165, 255, z) * 8 +
  Math.sin(z * 0.022) * 2;

const teeFeature: CourseFeature = {
  centerX: 0,
  centerZ: 0,
  radiusX: 11,
  radiusZ: 9,
  angleRad: 0,
};

const greenFeature: CourseFeature = {
  centerX: 2.5,
  centerZ: 252,
  radiusX: 18,
  radiusZ: 13.5,
  angleRad: 0.12,
};

const bunkerFeatures: CourseFeature[] = [
  {
    centerX: -14,
    centerZ: 222,
    radiusX: 8.5,
    radiusZ: 5.5,
    angleRad: -0.38,
  },
  {
    centerX: 18,
    centerZ: 238,
    radiusX: 9.2,
    radiusZ: 6.8,
    angleRad: 0.32,
  },
  {
    centerX: -9,
    centerZ: 265,
    radiusX: 7.4,
    radiusZ: 5,
    angleRad: 0.08,
  },
];

const getSurfaceWeights = (x: number, z: number): SurfaceWeights => {
  const fairwayCenter = corridorCenterX(z);
  const fairwayDistance = Math.abs(x - fairwayCenter);
  const corridorEnvelope = smoothstep(6, 24, z) * (1 - smoothstep(258, 315, z));
  const fairway = inverseSmoothBand(fairwayDistance, fairwayHalfWidth(z), 16) * corridorEnvelope;

  const teeDistance = ellipseDistance(x, z, teeFeature);
  const tee = inverseSmoothBand(teeDistance, 1, 0.22);

  const greenDistance = ellipseDistance(x, z, greenFeature);
  const green = inverseSmoothBand(greenDistance, 1, 0.18);
  const fringe =
    clamp01(inverseSmoothBand(greenDistance, 1.18, 0.2) - green * 0.72) *
    smoothstep(180, 305, z);

  const bunker = bunkerFeatures.reduce((max, feature) => {
    const distance = ellipseDistance(x, z, feature);
    return Math.max(max, inverseSmoothBand(distance, 1, 0.18));
  }, 0);

  const rough = clamp01(
    1 - Math.max(tee * 0.96, fairway * 0.9, green, fringe * 0.82, bunker * 0.98),
  );

  return {
    tee,
    fairway,
    rough,
    green,
    bunker,
    fringe,
  };
};

const classifySurface = (weights: SurfaceWeights): SurfaceType => {
  if (weights.bunker > 0.28) {
    return "bunker";
  }
  if (weights.green > 0.38) {
    return "green";
  }
  if (weights.fringe > 0.25) {
    return "fringe";
  }
  if (weights.tee > 0.42) {
    return "tee";
  }
  if (weights.fairway > 0.34) {
    return "fairway";
  }
  return "rough";
};

const rollingBaseHeight = (x: number, z: number): number =>
  Math.sin(z * 0.014) * 0.9 +
  Math.cos(x * 0.03) * 0.25 +
  Math.sin((x + z) * 0.022) * 0.22 +
  Math.cos((z - x) * 0.016) * 0.16;

/**
 * Bunker profile: a bowl that is deepest in the middle and climbs to a raised
 * lip just outside the sand line. The lip is taller on the side facing the
 * green, the way greenside bunkers are usually built up.
 */
const bunkerHeightOffset = (x: number, z: number, bunker: CourseFeature): number => {
  const distance = ellipseDistance(x, z, bunker);
  if (distance > 1.6) {
    return 0;
  }

  const bowl = 1 - smoothstep(0.55, 1.15, distance);
  const lip = smoothstep(1.0, 1.22, distance) * (1 - smoothstep(1.22, 1.55, distance));

  const toGreenX = greenFeature.centerX - bunker.centerX;
  const toGreenZ = greenFeature.centerZ - bunker.centerZ;
  const toGreenLength = Math.hypot(toGreenX, toGreenZ) || 1;
  const offsetX = x - bunker.centerX;
  const offsetZ = z - bunker.centerZ;
  const offsetLength = Math.hypot(offsetX, offsetZ) || 1;
  const facingGreen =
    0.5 + 0.5 * ((offsetX * toGreenX + offsetZ * toGreenZ) / (toGreenLength * offsetLength));
  const lipHeight =
    BUNKER_LIP_OUTER_M + (BUNKER_LIP_GREEN_SIDE_M - BUNKER_LIP_OUTER_M) * facingGreen;

  return -bowl * BUNKER_DEPTH_M + lip * lipHeight;
};

const getTerrainHeight = (x: number, z: number): number => {
  const weights = getSurfaceWeights(x, z);
  const baseHeight = rollingBaseHeight(x, z);

  let height =
    baseHeight *
    (1 - weights.fairway * 0.52 - weights.green * 0.8 - weights.fringe * 0.65 - weights.tee * 0.7);

  const teeBlend = weights.tee;
  const greenBlend = Math.max(weights.green, weights.fringe * 0.75);
  const fairwayBlend = Math.max(weights.fairway, weights.fringe * 0.45);

  const greenSurface =
    GREEN_HEIGHT_M +
    Math.sin(x * 0.35 + 1.2) * GREEN_UNDULATION_M +
    Math.sin(z * 0.28 - 0.4) * GREEN_UNDULATION_M * 0.8 +
    (z - greenFeature.centerZ) * GREEN_TILT_PER_M;

  height = height * (1 - teeBlend) + TEE_HEIGHT_M * teeBlend;
  height = height * (1 - greenBlend) + greenSurface * greenBlend;
  height = height * (1 - fairwayBlend * 0.25) + 0.03 * fairwayBlend * 0.25;

  for (const bunker of bunkerFeatures) {
    height += bunkerHeightOffset(x, z, bunker);
  }

  return height;
};

export const createFieldModel = (): FieldModel => ({
  terrainWidthM: TERRAIN_WIDTH_M,
  terrainLengthM: TERRAIN_LENGTH_M,
  holeLengthM: HOLE_LENGTH_M,
  green: greenFeature,
  bunkers: bunkerFeatures,
  getHeight: getTerrainHeight,
  getBaseHeight: rollingBaseHeight,
  getSurfaceWeights,
  getSurfaceType: (x, z) => classifySurface(getSurfaceWeights(x, z)),
  getCorridorCenterX: corridorCenterX,
  getFairwayHalfWidth: fairwayHalfWidth,
  getFeatureDistance: ellipseDistance,
});

/** Walk from -halfExtent to +halfExtent, stepping by the local spacing. */
const buildAxisSamples = (
  halfExtent: number,
  spacingAt: (coordinate: number) => number,
): number[] => {
  const samples = [-halfExtent];
  let coordinate = -halfExtent;
  while (coordinate < halfExtent) {
    coordinate = Math.min(halfExtent, coordinate + spacingAt(coordinate));
    samples.push(coordinate);
  }
  return samples;
};

const blendSpacing = (fineMask: number, corridorMask: number): number =>
  OUTSKIRT_SPACING_M -
  (OUTSKIRT_SPACING_M - CORRIDOR_SPACING_M) * corridorMask -
  (CORRIDOR_SPACING_M - FINE_SPACING_M) * fineMask;

const xSpacing = (x: number): number => {
  const corridorMask = 1 - smoothstep(58, 140, Math.abs(x));
  const fineMask = 1 - smoothstep(40, 52, Math.abs(x));
  return blendSpacing(fineMask, corridorMask);
};

const zSpacing = (z: number): number => {
  const corridorMask = smoothstep(-45, -18, z) * (1 - smoothstep(322, 352, z));
  const teeMask = 1 - smoothstep(14, 32, Math.abs(z - 4));
  const greenComplexMask = 1 - smoothstep(58, 72, Math.abs(z - 242));
  return blendSpacing(Math.max(teeMask, greenComplexMask), corridorMask);
};

/**
 * Non-uniform grid so the bunker bowls and the green contour get sub-metre
 * triangles without paying for that density across the whole 540 x 660 m field.
 * UVs stay a planar map of world XZ, matching the splat mask and tint textures.
 */
export const createTerrainMesh = (scene: Scene, field: FieldModel): Mesh => {
  const xs = buildAxisSamples(field.terrainWidthM / 2, xSpacing);
  const zs = buildAxisSamples(field.terrainLengthM / 2, zSpacing);
  const columns = xs.length;
  const rows = zs.length;

  const positions = new Float32Array(columns * rows * 3);
  const uvs = new Float32Array(columns * rows * 2);
  const indices = new Uint32Array((columns - 1) * (rows - 1) * 6);

  for (let row = 0; row < rows; row += 1) {
    const z = zs[row];
    for (let column = 0; column < columns; column += 1) {
      const x = xs[column];
      const vertex = row * columns + column;
      positions[vertex * 3] = x;
      positions[vertex * 3 + 1] = field.getHeight(x, z);
      positions[vertex * 3 + 2] = z;
      uvs[vertex * 2] = x / field.terrainWidthM + 0.5;
      uvs[vertex * 2 + 1] = z / field.terrainLengthM + 0.5;
    }
  }

  let cursor = 0;
  for (let row = 0; row < rows - 1; row += 1) {
    for (let column = 0; column < columns - 1; column += 1) {
      const a = row * columns + column;
      const b = a + 1;
      const c = a + columns;
      const d = c + 1;
      // Same winding as MeshBuilder.CreateGround, so the top face is the front
      // face and ComputeNormals yields +Y normals.
      indices[cursor++] = a;
      indices[cursor++] = b;
      indices[cursor++] = c;
      indices[cursor++] = b;
      indices[cursor++] = d;
      indices[cursor++] = c;
    }
  }

  const normals = new Float32Array(positions.length);
  VertexData.ComputeNormals(positions, indices, normals);

  const vertexData = new VertexData();
  vertexData.positions = positions;
  vertexData.indices = indices;
  vertexData.normals = normals;
  vertexData.uvs = uvs;

  const terrain = new Mesh("course-terrain", scene);
  vertexData.applyToMesh(terrain, false);
  terrain.refreshBoundingInfo();
  return terrain;
};
