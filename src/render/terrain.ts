import { Mesh, MeshBuilder, Scene, VertexBuffer, VertexData } from "@babylonjs/core";
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
  getSurfaceWeights(x: number, z: number): SurfaceWeights;
  getSurfaceType(x: number, z: number): SurfaceType;
  getCorridorCenterX(z: number): number;
}

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

const getTerrainHeight = (x: number, z: number): number => {
  const weights = getSurfaceWeights(x, z);
  const baseHeight = rollingBaseHeight(x, z);

  let height =
    baseHeight *
    (1 - weights.fairway * 0.52 - weights.green * 0.8 - weights.fringe * 0.65 - weights.tee * 0.7);

  const teeBlend = weights.tee;
  const greenBlend = Math.max(weights.green, weights.fringe * 0.75);
  const fairwayBlend = Math.max(weights.fairway, weights.fringe * 0.45);

  height = height * (1 - teeBlend) + 0.06 * teeBlend;
  height = height * (1 - greenBlend) + 0.1 * greenBlend;
  height = height * (1 - fairwayBlend * 0.25) + 0.03 * fairwayBlend * 0.25;

  for (const bunker of bunkerFeatures) {
    const distance = ellipseDistance(x, z, bunker);
    const bowl = inverseSmoothBand(distance, 1, 0.24);
    const lip = clamp01(inverseSmoothBand(distance, 1.22, 0.14) - bowl * 0.74);
    height -= bowl * 0.55;
    height += lip * 0.12;
  }

  return height;
};

export const createFieldModel = (): FieldModel => ({
  terrainWidthM: 540,
  terrainLengthM: 660,
  holeLengthM: 280,
  green: greenFeature,
  bunkers: bunkerFeatures,
  getHeight: getTerrainHeight,
  getSurfaceWeights,
  getSurfaceType: (x, z) => classifySurface(getSurfaceWeights(x, z)),
  getCorridorCenterX: corridorCenterX,
});

export const createTerrainMesh = (scene: Scene, field: FieldModel): Mesh => {
  const terrain = MeshBuilder.CreateGround(
    "course-terrain",
    {
      width: field.terrainWidthM,
      height: field.terrainLengthM,
      subdivisions: 180,
    },
    scene,
  );

  const positions = terrain.getVerticesData(VertexBuffer.PositionKind);
  if (positions) {
    const indices = terrain.getIndices();
    for (let index = 0; index < positions.length; index += 3) {
      const x = positions[index];
      const z = positions[index + 2];
      positions[index + 1] = field.getHeight(x, z);
    }

    terrain.updateVerticesData(VertexBuffer.PositionKind, positions);
    if (indices) {
      const normals: number[] = [];
      VertexData.ComputeNormals(positions, indices, normals);
      terrain.updateVerticesData(VertexBuffer.NormalKind, normals);
    }
    terrain.refreshBoundingInfo();
  }

  return terrain;
};
