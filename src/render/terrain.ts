import { Mesh, Scene, VertexData } from "@babylonjs/core";
import type { SurfaceType } from "../types/simulation";
import { clamp01, smoothstep, valueNoise } from "./proceduralNoise";

export interface SurfaceWeights {
  tee: number;
  fairway: number;
  rough: number;
  green: number;
  bunker: number;
  fringe: number;
  water: number;
}

export interface CourseFeature {
  centerX: number;
  centerZ: number;
  radiusX: number;
  radiusZ: number;
  angleRad: number;
  /**
   * Outline wobble as a fraction of the radius. Zero keeps a clean ellipse;
   * bunkers and the pond use it for hand-shaped, irregular edges.
   */
  wobble?: number;
  /** Phase for the wobble so features sharing an amplitude still differ. */
  wobbleSeed?: number;
  /**
   * Superellipse exponent: 2 is an ellipse, higher values square it off into
   * a rounded rectangle (used for the tee box).
   */
  squareness?: number;
}

export interface FieldModel {
  terrainWidthM: number;
  terrainLengthM: number;
  holeLengthM: number;
  green: CourseFeature;
  bunkers: CourseFeature[];
  pond: CourseFeature;
  /** World Y of the pond's water surface. */
  waterLevelY: number;
  /** Cart path centre line; it runs from cartPathStartZ to cartPathEndZ. */
  getCartPathX(z: number): number;
  cartPathHalfWidthM: number;
  cartPathStartZ: number;
  cartPathEndZ: number;
  /**
   * Ground height in world Y. The physics lands, bounces and rolls the ball on
   * this same surface (see core/collision.ts), so it is not just visual.
   */
  getHeight(x: number, z: number): number;
  /** Height of the underlying landform with no course features applied. */
  getBaseHeight(x: number, z: number): number;
  getSurfaceWeights(x: number, z: number): SurfaceWeights;
  getSurfaceType(x: number, z: number): SurfaceType;
  getCorridorCenterX(z: number): number;
  getFairwayHalfWidth(z: number): number;
  /** Normalised distance to a feature's outline: 1 on it, 0 at its centre. */
  getFeatureDistance(x: number, z: number, feature: CourseFeature): number;
}

const TERRAIN_WIDTH_M = 540;
const TERRAIN_LENGTH_M = 660;
const HOLE_LENGTH_M = 280;

// Landform: the hole drops into a shallow dip in the driving zone and climbs
// to a raised green, inside a valley whose sides rise toward the tree lines.
const FAIRWAY_DIP_M = 1.8;
const FAIRWAY_DIP_CENTER_Z = 115;
const FAIRWAY_DIP_WIDTH_Z = 65;
const GREEN_RISE_M = 2.6;
const VALLEY_RISE_M = 8;
const BACKSTOP_RISE_M = 5;
const BEHIND_TEE_RISE_M = 3;

// Mounds in the rough between the fairway and the tree lines.
const MOUND_HEIGHT_M = 3.2;
const MOUND_NOISE_SCALE = 0.05;

const TEE_BOX_HEIGHT_M = 0.6;
/** Tee box shoulder width, as a fraction of its radius. */
const TEE_BOX_SHOULDER = 0.3;

const GREEN_PLATEAU_M = 0.9;
const GREEN_UNDULATION_M = 0.12;
/** The green rises toward the back, so it slopes toward the approach. */
const GREEN_TILT_PER_M = 0.012;

const BUNKER_DEPTH_M = 1.3;
const BUNKER_LIP_OUTER_M = 0.12;
const BUNKER_LIP_GREEN_SIDE_M = 0.5;

/** Height of the bank above the waterline right at the pond outline. */
const POND_SHORE_HEIGHT_M = 0.35;
/**
 * Outline distance over which the shore rises to that height. Short and steep,
 * so the ground just outside the pond stays clearly above the water plane and
 * never flickers against it from the far cameras.
 */
const POND_SHORE_WIDTH = 0.15;
/** Depth of the pond bed below the waterline, and a small step down at the shore. */
const POND_BED_DEPTH_M = 1.0;
const POND_SHORE_STEP_M = 0.08;
/** Rise per metre of the bank cut into higher ground beside the pond. */
const POND_BANK_GRADE = 0.22;
// Where ground around the pond sits below the shore, a berm raises it; the
// berm fades back into the terrain between these outline distances.
const POND_BERM_FADE_START = 1.25;
const POND_BERM_FADE_END = 1.6;
/** Outline distance beyond which the pond no longer shapes the terrain. */
const POND_INFLUENCE = 2.6;
// Samples used to find the lowest ground along the pond outline.
const POND_SHORE_SAMPLES = 180;
const POND_SHORE_SEARCH_MIN = 0.8;
const POND_SHORE_SEARCH_MAX = 1.4;
const POND_SHORE_SEARCH_STEP = 0.01;

const CART_PATH_HALF_WIDTH_M = 1.3;
/** Gap between the fairway edge and the cart path centre line. */
const CART_PATH_OFFSET_M = 19;
const CART_PATH_START_Z = 6;
const CART_PATH_END_Z = 244;
/** X where the path leaves the tee box, just off its left side. */
const CART_PATH_TEE_X = -9;

// Grid spacing (m): dense around the tee, the green complex and the pond,
// coarse outside.
const FINE_SPACING_M = 0.9;
const CORRIDOR_SPACING_M = 2.2;
const OUTSKIRT_SPACING_M = 6;

const inverseSmoothBand = (distance: number, radius: number, falloff: number): number =>
  1 - smoothstep(radius, radius + falloff, distance);

const featureDistance = (x: number, z: number, feature: CourseFeature): number => {
  const translatedX = x - feature.centerX;
  const translatedZ = z - feature.centerZ;
  const cos = Math.cos(feature.angleRad);
  const sin = Math.sin(feature.angleRad);
  const localX = (translatedX * cos + translatedZ * sin) / feature.radiusX;
  const localZ = (-translatedX * sin + translatedZ * cos) / feature.radiusZ;

  const exponent = feature.squareness ?? 2;
  const distance =
    exponent === 2
      ? Math.hypot(localX, localZ)
      : (Math.abs(localX) ** exponent + Math.abs(localZ) ** exponent) ** (1 / exponent);

  const wobble = feature.wobble ?? 0;
  if (wobble === 0) {
    return distance;
  }
  // Scaling the distance by the angle pushes lobes out and pulls bays in.
  const angle = Math.atan2(localZ, localX);
  const seed = feature.wobbleSeed ?? 0;
  const lobes = 0.6 * Math.sin(2 * angle + seed) + 0.4 * Math.sin(3 * angle + seed * 2.3);
  return distance / (1 + wobble * lobes);
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
  centerZ: 2,
  radiusX: 6,
  radiusZ: 10,
  angleRad: 0,
  squareness: 4,
};

const greenFeature: CourseFeature = {
  centerX: 2.5,
  centerZ: 252,
  radiusX: 18,
  radiusZ: 13.5,
  angleRad: 0.12,
  wobble: 0.07,
  wobbleSeed: 1.1,
};

const bunkerFeatures: CourseFeature[] = [
  {
    centerX: -14,
    centerZ: 222,
    radiusX: 8.5,
    radiusZ: 5.5,
    angleRad: -0.38,
    wobble: 0.2,
    wobbleSeed: 0.4,
  },
  {
    centerX: 18,
    centerZ: 238,
    radiusX: 9.2,
    radiusZ: 6.8,
    angleRad: 0.32,
    wobble: 0.22,
    wobbleSeed: 2.7,
  },
  {
    centerX: -9,
    centerZ: 265,
    radiusX: 7.4,
    radiusZ: 5,
    angleRad: 0.08,
    wobble: 0.18,
    wobbleSeed: 4.9,
  },
];

/** Water hazard right of the driving zone, where a slice or push ends up. */
const pondFeature: CourseFeature = {
  centerX: 66,
  centerZ: 172,
  radiusX: 15,
  radiusZ: 30,
  angleRad: 0.2,
  wobble: 0.1,
  wobbleSeed: 3.3,
};

const rollingHeight = (x: number, z: number): number =>
  Math.sin(z * 0.014) * 0.9 +
  Math.cos(x * 0.03) * 0.25 +
  Math.sin((x + z) * 0.022) * 0.22 +
  Math.cos((z - x) * 0.016) * 0.16;

const holeLandform = (x: number, z: number): number => {
  const dipOffset = (z - FAIRWAY_DIP_CENTER_Z) / FAIRWAY_DIP_WIDTH_Z;
  const dip = -FAIRWAY_DIP_M * Math.exp(-dipOffset * dipOffset);
  const riseToGreen = GREEN_RISE_M * smoothstep(160, 240, z);
  const valley = VALLEY_RISE_M * smoothstep(32, 150, Math.abs(x - corridorCenterX(z)));
  const backstop = BACKSTOP_RISE_M * smoothstep(280, 340, z);
  const behindTee = BEHIND_TEE_RISE_M * smoothstep(-20, -90, z);
  return dip + riseToGreen + valley + backstop + behindTee;
};

const baseHeight = (x: number, z: number): number => holeLandform(x, z) + rollingHeight(x, z);

const cartPathX = (z: number): number => {
  const alongside =
    corridorCenterX(z) - fairwayHalfWidth(z) - CART_PATH_OFFSET_M + Math.sin(z * 0.05) * 2;
  const leaveTee = smoothstep(CART_PATH_START_Z, 40, z);
  return CART_PATH_TEE_X + (alongside - CART_PATH_TEE_X) * leaveTee;
};

/** Lateral distance to the cart path, or Infinity beyond its ends. */
const cartPathDistance = (x: number, z: number): number =>
  z < CART_PATH_START_Z || z > CART_PATH_END_Z ? Infinity : Math.abs(x - cartPathX(z));

const moundHeight = (x: number, z: number): number => {
  const beyondFairway = Math.abs(x - corridorCenterX(z)) - fairwayHalfWidth(z);
  const band = smoothstep(4, 12, beyondFairway) * (1 - smoothstep(40, 70, beyondFairway));
  const alongHole = smoothstep(20, 50, z) * (1 - smoothstep(270, 300, z));
  const bumps = smoothstep(
    0.42,
    0.85,
    valueNoise(x * MOUND_NOISE_SCALE + 3.1, z * MOUND_NOISE_SCALE - 1.7),
  );
  const pathClear = smoothstep(CART_PATH_HALF_WIDTH_M + 1, CART_PATH_HALF_WIDTH_M + 6, cartPathDistance(x, z));
  const pondClear = smoothstep(1.3, 2.0, featureDistance(x, z, pondFeature));
  return MOUND_HEIGHT_M * band * alongHole * bumps * pathClear * pondClear;
};

const getSurfaceWeights = (x: number, z: number): SurfaceWeights => {
  const fairwayCenter = corridorCenterX(z);
  const fairwayDistance = Math.abs(x - fairwayCenter);
  const corridorEnvelope = smoothstep(6, 24, z) * (1 - smoothstep(258, 315, z));
  const fairway = inverseSmoothBand(fairwayDistance, fairwayHalfWidth(z), 16) * corridorEnvelope;

  const tee = inverseSmoothBand(featureDistance(x, z, teeFeature), 1, 0.22);

  const greenDistance = featureDistance(x, z, greenFeature);
  const green = inverseSmoothBand(greenDistance, 1, 0.18);
  const fringe =
    clamp01(inverseSmoothBand(greenDistance, 1.18, 0.2) - green * 0.72) *
    smoothstep(180, 305, z);

  const bunker = bunkerFeatures.reduce((max, feature) => {
    const distance = featureDistance(x, z, feature);
    return Math.max(max, inverseSmoothBand(distance, 1, 0.18));
  }, 0);

  const water = inverseSmoothBand(featureDistance(x, z, pondFeature), 1, 0.06);

  const rough = clamp01(
    1 - Math.max(tee * 0.96, fairway * 0.9, green, fringe * 0.82, bunker * 0.98, water),
  );

  return {
    tee,
    fairway,
    rough,
    green,
    bunker,
    fringe,
    water,
  };
};

/**
 * Weight above which a point counts as each surface, checked in this order.
 * The terrain material paints its edges at the same weights, so what the ball
 * lands on always matches what the viewer sees.
 */
export const SURFACE_THRESHOLDS = {
  water: 0.5,
  bunker: 0.28,
  green: 0.38,
  fringe: 0.25,
  tee: 0.42,
  fairway: 0.34,
} as const;

/** The cart path is visual only: the physics treats it as the rough around it. */
const classifySurface = (weights: SurfaceWeights): SurfaceType => {
  if (weights.water > SURFACE_THRESHOLDS.water) {
    return "water";
  }
  if (weights.bunker > SURFACE_THRESHOLDS.bunker) {
    return "bunker";
  }
  if (weights.green > SURFACE_THRESHOLDS.green) {
    return "green";
  }
  if (weights.fringe > SURFACE_THRESHOLDS.fringe) {
    return "fringe";
  }
  if (weights.tee > SURFACE_THRESHOLDS.tee) {
    return "tee";
  }
  if (weights.fairway > SURFACE_THRESHOLDS.fairway) {
    return "fairway";
  }
  return "rough";
};

/**
 * Bunker profile: a bowl that is deepest in the middle and climbs to a raised
 * lip just outside the sand line. The lip is taller on the side facing the
 * green, the way greenside bunkers are usually built up.
 */
const bunkerHeightOffset = (x: number, z: number, bunker: CourseFeature): number => {
  const distance = featureDistance(x, z, bunker);
  if (distance > 1.6) {
    return 0;
  }

  const bowl = 1 - smoothstep(0.5, 1.08, distance);
  const lip = smoothstep(1.0, 1.18, distance) * (1 - smoothstep(1.18, 1.55, distance));

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

/**
 * Lowest ground along the pond outline. The waterline sits just below it, so
 * the pond fills to its lowest shore and nowhere spills over.
 */
const lowestGroundOnPondOutline = (): number => {
  const cos = Math.cos(pondFeature.angleRad);
  const sin = Math.sin(pondFeature.angleRad);
  let lowest = Infinity;
  for (let step = 0; step < POND_SHORE_SAMPLES; step += 1) {
    const angle = (step / POND_SHORE_SAMPLES) * Math.PI * 2;
    // Walk outward along the ray until it crosses the (wobbly) outline.
    for (let ring = POND_SHORE_SEARCH_MIN; ring <= POND_SHORE_SEARCH_MAX; ring += POND_SHORE_SEARCH_STEP) {
      const localX = Math.cos(angle) * ring * pondFeature.radiusX;
      const localZ = Math.sin(angle) * ring * pondFeature.radiusZ;
      const x = pondFeature.centerX + localX * cos - localZ * sin;
      const z = pondFeature.centerZ + localX * sin + localZ * cos;
      if (featureDistance(x, z, pondFeature) >= 1) {
        lowest = Math.min(lowest, featureHeight(x, z));
        break;
      }
    }
  }
  return lowest;
};

/**
 * Pond relief: a bed below the waterline inside the outline, a short steep
 * shore, then a bank that is cut into higher ground at a steady grade and
 * built up as a berm wherever the surrounding ground is lower than the shore.
 * The pond sits on the valley side, so it gets a cut bank uphill and a low
 * berm downhill instead of a flat terrace.
 */
const pondHeight = (x: number, z: number, height: number): number => {
  const distance = featureDistance(x, z, pondFeature);
  if (distance > POND_INFLUENCE) {
    return height;
  }
  if (distance < 1) {
    return waterLevelY - POND_SHORE_STEP_M - POND_BED_DEPTH_M * smoothstep(1.0, 0.55, distance);
  }

  const shore = waterLevelY + POND_SHORE_HEIGHT_M * smoothstep(1.0, 1.0 + POND_SHORE_WIDTH, distance);
  const meanRadius = (pondFeature.radiusX + pondFeature.radiusZ) / 2;
  const bankTop = shore + POND_BANK_GRADE * (distance - 1) * meanRadius;
  const cut = Math.min(height, bankTop);
  const berm = 1 - smoothstep(POND_BERM_FADE_START, POND_BERM_FADE_END, distance);
  return cut + Math.max(0, shore - cut) * berm;
};

/** Terrain height from the landform, mounds, tee, green and bunkers; everything but the pond. */
const featureHeight = (x: number, z: number): number => {
  const weights = getSurfaceWeights(x, z);
  const rollingDamping =
    1 - weights.fairway * 0.2 - weights.green * 0.8 - weights.fringe * 0.65 - weights.tee * 0.7;

  let height =
    holeLandform(x, z) + rollingHeight(x, z) * rollingDamping + moundHeight(x, z) * weights.rough;

  // Raised, flat-topped tee box with sloped shoulders.
  const teeTop = baseHeight(teeFeature.centerX, teeFeature.centerZ) + TEE_BOX_HEIGHT_M;
  const teeBox = inverseSmoothBand(featureDistance(x, z, teeFeature), 1, TEE_BOX_SHOULDER);
  height += (teeTop - height) * teeBox;

  // Green plateau with a shoulder that falls away beyond the fringe.
  const greenDistance = featureDistance(x, z, greenFeature);
  const greenSurface =
    baseHeight(greenFeature.centerX, greenFeature.centerZ) +
    GREEN_PLATEAU_M +
    Math.sin(x * 0.21 + 1.2) * GREEN_UNDULATION_M +
    Math.sin(z * 0.17 - 0.4) * GREEN_UNDULATION_M * 0.8 +
    (z - greenFeature.centerZ) * GREEN_TILT_PER_M;
  const greenShoulder = inverseSmoothBand(greenDistance, 1.12, 0.55);
  height += (greenSurface - height) * greenShoulder;

  for (const bunker of bunkerFeatures) {
    height += bunkerHeightOffset(x, z, bunker);
  }

  return height;
};

const waterLevelY = lowestGroundOnPondOutline() - POND_SHORE_HEIGHT_M;

const getTerrainHeight = (x: number, z: number): number => pondHeight(x, z, featureHeight(x, z));

export const createFieldModel = (): FieldModel => ({
  terrainWidthM: TERRAIN_WIDTH_M,
  terrainLengthM: TERRAIN_LENGTH_M,
  holeLengthM: HOLE_LENGTH_M,
  green: greenFeature,
  bunkers: bunkerFeatures,
  pond: pondFeature,
  waterLevelY,
  getCartPathX: cartPathX,
  cartPathHalfWidthM: CART_PATH_HALF_WIDTH_M,
  cartPathStartZ: CART_PATH_START_Z,
  cartPathEndZ: CART_PATH_END_Z,
  getHeight: getTerrainHeight,
  getBaseHeight: baseHeight,
  getSurfaceWeights,
  getSurfaceType: (x, z) => classifySurface(getSurfaceWeights(x, z)),
  getCorridorCenterX: corridorCenterX,
  getFairwayHalfWidth: fairwayHalfWidth,
  getFeatureDistance: featureDistance,
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
  const corridorMask = 1 - smoothstep(95, 150, Math.abs(x));
  // Fine out to the pond on the right; the left side only needs the corridor.
  const fineMask = 1 - smoothstep(x > 0 ? 84 : 40, x > 0 ? 96 : 52, Math.abs(x));
  return blendSpacing(fineMask, corridorMask);
};

const zSpacing = (z: number): number => {
  const corridorMask = smoothstep(-45, -18, z) * (1 - smoothstep(322, 352, z));
  const teeMask = 1 - smoothstep(14, 32, Math.abs(z - 4));
  const pondMask = 1 - smoothstep(40, 55, Math.abs(z - pondFeature.centerZ));
  const greenComplexMask = 1 - smoothstep(58, 72, Math.abs(z - 242));
  return blendSpacing(Math.max(teeMask, pondMask, greenComplexMask), corridorMask);
};

/**
 * Non-uniform grid so the bunker bowls, the green contour and the pond bank
 * get sub-metre triangles without paying for that density across the whole
 * 540 x 660 m field. UVs stay a planar map of world XZ, matching the surface
 * mask and tint textures.
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
