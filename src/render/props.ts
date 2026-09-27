import {
  Color4,
  DynamicTexture,
  Matrix,
  Mesh,
  MeshBuilder,
  Quaternion,
  Scene,
  ShadowGenerator,
  StandardMaterial,
  Vector3,
  VertexBuffer,
} from "@babylonjs/core";
import type { FieldMaterials } from "./materials";
import type { FieldModel } from "./terrain";

const hash = (seed: number): number => {
  const value = Math.sin(seed * 12.9898) * 43758.5453;
  return value - Math.floor(value);
};

const clamp01 = (value: number): number => Math.max(0, Math.min(1, value));

const smoothstep = (edge0: number, edge1: number, value: number): number => {
  const t = clamp01((value - edge0) / (edge1 - edge0));
  return t * t * (3 - 2 * t);
};

// Backdrop: hills rise beyond the playable field and hide its edge.
const BACKDROP_SIZE_M = 2000;
const BACKDROP_SUBDIVISIONS = 96;
/** How far below the terrain the backdrop sits inside the field: deeper than any bunker bowl. */
const BACKDROP_SINK_M = 1.4;
const BACKDROP_EDGE_SINK_M = 0.15;
const HILL_RISE_M = 55;

const FLAG_POLE_HEIGHT_M = 2.3;
const CUP_DIAMETER_M = 0.108;

/** Everything near enough to the hole to throw a visible shadow. */
const SHADOW_CASTER_MAX_Z = 320;

const createDistanceMarker = (
  scene: Scene,
  field: FieldModel,
  distanceM: number,
  label: string,
): Mesh => {
  const marker = MeshBuilder.CreateGround(
    `distance-marker-${label}`,
    { width: 6, height: 2.4 },
    scene,
  );
  marker.position.set(
    field.getCorridorCenterX(distanceM),
    field.getHeight(field.getCorridorCenterX(distanceM), distanceM) + 0.05,
    distanceM,
  );
  marker.rotation.y = Math.PI;

  const texture = new DynamicTexture(`distance-marker-texture-${label}`, { width: 256, height: 96 }, scene, false);
  const context = texture.getContext() as unknown as CanvasRenderingContext2D;
  context.fillStyle = "rgba(16, 38, 18, 0.78)";
  context.fillRect(0, 0, 256, 96);
  context.strokeStyle = "rgba(255,255,255,0.32)";
  context.lineWidth = 4;
  context.strokeRect(8, 8, 240, 80);
  context.fillStyle = "#f5f6ea";
  context.font = "bold 34px Segoe UI";
  context.textAlign = "center";
  context.textBaseline = "middle";
  // Ground UVs mirror the canvas when seen from the tee: draw the label
  // mirrored and turn the plate so it reads the right way up.
  context.save();
  context.translate(256, 0);
  context.scale(-1, 1);
  context.fillText(label, 128, 48);
  context.restore();
  texture.update(false);
  texture.hasAlpha = true;

  const material = new StandardMaterial(`distance-marker-material-${label}`, scene);
  material.diffuseTexture = texture;
  material.emissiveColor.set(0.12, 0.14, 0.11);
  material.specularColor.set(0, 0, 0);
  marker.material = material;
  return marker;
};

const paintVertexColors = (
  mesh: Mesh,
  colorAt: (x: number, y: number, z: number) => Color4,
): void => {
  const positions = mesh.getVerticesData(VertexBuffer.PositionKind);
  if (!positions) {
    return;
  }
  const colors: number[] = [];
  for (let index = 0; index < positions.length; index += 3) {
    const color = colorAt(positions[index], positions[index + 1], positions[index + 2]);
    colors.push(color.r, color.g, color.b, color.a);
  }
  mesh.setVerticesData(VertexBuffer.ColorKind, colors);
};

interface TreeVariantSpec {
  seed: number;
  trunkHeight: number;
  trunkRadius: number;
  canopyRadius: number;
  canopyHeight: number;
  blobCount: number;
  /** Base canopy colour; blobs vary around it. */
  hue: { r: number; g: number; b: number };
}

/**
 * A tree is a tapered trunk plus a cluster of overlapping ellipsoids, merged
 * into one mesh so it can be instanced. Vertex colours shade each blob a little
 * differently and darken the underside, which is what sells the silhouette at
 * broadcast distance without any leaf texture.
 */
const createTreeVariant = (
  scene: Scene,
  name: string,
  spec: TreeVariantSpec,
  materials: FieldMaterials,
): Mesh => {
  const parts: Mesh[] = [];

  const trunk = MeshBuilder.CreateCylinder(
    `${name}-trunk`,
    {
      height: spec.trunkHeight,
      diameterBottom: spec.trunkRadius * 2.2,
      diameterTop: spec.trunkRadius * 1.3,
      tessellation: 8,
    },
    scene,
  );
  trunk.position.y = spec.trunkHeight / 2;
  paintVertexColors(trunk, (_x, y) => {
    const shade = 0.85 + (y / spec.trunkHeight) * 0.25;
    return new Color4(0.38 * shade, 0.27 * shade, 0.17 * shade, 1);
  });
  parts.push(trunk);

  const canopyBaseY = spec.trunkHeight * 0.75;
  for (let blob = 0; blob < spec.blobCount; blob += 1) {
    const seed = spec.seed * 31 + blob * 7;
    const angle = hash(seed + 1) * Math.PI * 2;
    const spread = blob === 0 ? 0 : (0.3 + hash(seed + 2) * 0.55) * spec.canopyRadius;
    const radius = spec.canopyRadius * (blob === 0 ? 1 : 0.55 + hash(seed + 3) * 0.4);
    const lift = blob === 0 ? spec.canopyHeight * 0.5 : hash(seed + 4) * spec.canopyHeight * 0.75;

    const sphere = MeshBuilder.CreateSphere(
      `${name}-canopy-${blob}`,
      { diameter: radius * 2, segments: 7 },
      scene,
    );
    sphere.scaling.set(1, 0.78 + hash(seed + 5) * 0.2, 1);
    sphere.position.set(
      Math.cos(angle) * spread,
      canopyBaseY + lift,
      Math.sin(angle) * spread,
    );
    sphere.bakeCurrentTransformIntoVertices();

    const blobTint = 0.86 + hash(seed + 6) * 0.28;
    const warmth = (hash(seed + 8) - 0.5) * 0.08;
    paintVertexColors(sphere, (_x, y) => {
      const underside = smoothstep(canopyBaseY + spec.canopyHeight * 0.9, canopyBaseY - spec.canopyRadius * 0.6, y);
      const shade = blobTint * (1 - underside * 0.42);
      return new Color4(
        (spec.hue.r + warmth) * shade,
        spec.hue.g * shade,
        (spec.hue.b - warmth * 0.5) * shade,
        1,
      );
    });
    parts.push(sphere);
  }

  const merged = Mesh.MergeMeshes(parts, true, true, undefined, false, false);
  if (!merged) {
    throw new Error(`Failed to merge tree variant ${name}.`);
  }
  merged.name = name;
  merged.material = materials.treeCanopy;
  merged.isVisible = false;
  return merged;
};

const createTreeVariants = (scene: Scene, materials: FieldMaterials): Mesh[] => {
  const specs: TreeVariantSpec[] = [
    {
      seed: 1,
      trunkHeight: 5.2,
      trunkRadius: 0.32,
      canopyRadius: 4.2,
      canopyHeight: 5.4,
      blobCount: 6,
      hue: { r: 0.3, g: 0.46, b: 0.2 },
    },
    {
      seed: 2,
      trunkHeight: 6.4,
      trunkRadius: 0.36,
      canopyRadius: 3.6,
      canopyHeight: 7.2,
      blobCount: 7,
      hue: { r: 0.26, g: 0.42, b: 0.19 },
    },
    {
      seed: 3,
      trunkHeight: 4.4,
      trunkRadius: 0.4,
      canopyRadius: 5,
      canopyHeight: 4.6,
      blobCount: 5,
      hue: { r: 0.34, g: 0.47, b: 0.22 },
    },
  ];
  return specs.map((spec, index) => createTreeVariant(scene, `tree-variant-${index}`, spec, materials));
};

interface TreePlacement {
  x: number;
  z: number;
  scale: number;
}

const placeTrees = (
  variants: Mesh[],
  placements: TreePlacement[],
  namePrefix: string,
  heightAt: (x: number, z: number) => number,
  shadowGenerator: ShadowGenerator | null,
): void => {
  placements.forEach((placement, index) => {
    const variant = variants[index % variants.length];
    const instance = variant.createInstance(`${namePrefix}-${index}`);
    instance.position.set(placement.x, heightAt(placement.x, placement.z) - 0.1, placement.z);
    instance.rotation.y = hash(index * 3.3 + 0.5) * Math.PI * 2;
    instance.scaling.set(
      placement.scale * (0.92 + hash(index * 1.9) * 0.16),
      placement.scale,
      placement.scale * (0.92 + hash(index * 2.7) * 0.16),
    );
    instance.isPickable = false;
    if (shadowGenerator && placement.z < SHADOW_CASTER_MAX_Z) {
      shadowGenerator.addShadowCaster(instance, false);
    }
  });
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
): TreePlacement[] => {
  const placements: TreePlacement[] = [];
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
const perimeterTreePlacements = (field: FieldModel): TreePlacement[] => {
  const placements: TreePlacement[] = [];
  const halfWidth = field.terrainWidthM / 2;
  const halfLength = field.terrainLengthM / 2;

  // Back wall behind the green, densest where the broadcast camera looks.
  for (let index = 0; index < 64; index += 1) {
    const x = -260 + (520 / 63) * index + (hash(index * 2.1 + 40) - 0.5) * 12;
    const z = 318 + hash(index * 5.3 + 41) * 40;
    placements.push({ x, z, scale: 1.1 + hash(index * 7.7 + 42) * 0.5 });
  }
  // Side rows, spaced so they read as a wood line rather than a fence.
  for (let index = 0; index < 40; index += 1) {
    const z = -halfLength + 40 + (halfLength * 2 - 80) * (index / 39) + (hash(index * 3.9 + 50) - 0.5) * 20;
    for (const side of [-1, 1]) {
      const x = side * (halfWidth - 60 - hash(index * 4.1 + 51 + side) * 90);
      placements.push({ x, z, scale: 1 + hash(index * 6.3 + 52 + side) * 0.45 });
    }
  }
  // Behind the tee.
  for (let index = 0; index < 22; index += 1) {
    const x = -180 + (360 / 21) * index + (hash(index * 2.3 + 60) - 0.5) * 14;
    const z = -60 - hash(index * 4.9 + 61) * 60;
    placements.push({ x, z, scale: 0.9 + hash(index * 8.1 + 62) * 0.5 });
  }
  return placements;
};

const createGrassSource = (scene: Scene, material: StandardMaterial): Mesh => {
  const firstBlade = MeshBuilder.CreatePlane(
    "grass-blade-a",
    { width: 0.5, height: 0.5 },
    scene,
  );
  firstBlade.material = material;
  firstBlade.position.y = 0.25;

  const secondBlade = firstBlade.clone("grass-blade-b")!;
  secondBlade.rotation.y = Math.PI / 2;

  const merged = Mesh.MergeMeshes([firstBlade, secondBlade], true, true, undefined, false, true);
  if (!merged) {
    throw new Error("Failed to create grass source mesh.");
  }
  merged.isPickable = false;
  return merged;
};

/**
 * Tufts of longer grass where the rough meets the fairway and around the
 * bunker lips: the places a golfer actually sees taller grass. The short
 * turf on tee, fairway and green is carried by the tiled textures.
 */
const scatterRoughGrass = (field: FieldModel, source: Mesh): void => {
  const matrices: number[] = [];
  const pushTuft = (x: number, z: number, seed: number): void => {
    const scale = 0.7 + hash(seed) * 0.7;
    const rotation = Quaternion.RotationAxis(Vector3.Up(), hash(seed + 0.5) * Math.PI);
    const matrix = Matrix.Compose(
      new Vector3(scale, scale * (0.8 + hash(seed + 0.7) * 0.5), scale),
      rotation,
      new Vector3(x, field.getHeight(x, z), z),
    );
    matrices.push(...matrix.toArray());
  };

  let seed = 0;
  for (let z = 14; z < 300; z += 1.3) {
    const center = field.getCorridorCenterX(z);
    const halfWidth = field.getFairwayHalfWidth(z);
    for (const side of [-1, 1]) {
      for (let band = 0; band < 5; band += 1) {
        seed += 1;
        const lateral = halfWidth + 2 + band * 2.6 + (hash(seed * 1.3) - 0.5) * 2.4;
        const x = center + side * lateral;
        const sampleZ = z + (hash(seed * 2.1) - 0.5) * 1.3;
        const weights = field.getSurfaceWeights(x, sampleZ);
        if (weights.rough > 0.4 && weights.fairway < 0.6 && weights.bunker < 0.05 && weights.green < 0.05) {
          pushTuft(x, sampleZ, seed);
        }
      }
    }
  }

  for (const bunker of field.bunkers) {
    for (let index = 0; index < 60; index += 1) {
      seed += 1;
      const angle = (index / 60) * Math.PI * 2 + (hash(seed) - 0.5) * 0.1;
      const distance = 1.28 + hash(seed * 1.7) * 0.3;
      const cos = Math.cos(bunker.angleRad);
      const sin = Math.sin(bunker.angleRad);
      const localX = Math.cos(angle) * bunker.radiusX * distance;
      const localZ = Math.sin(angle) * bunker.radiusZ * distance;
      const x = bunker.centerX + localX * cos - localZ * sin;
      const z = bunker.centerZ + localX * sin + localZ * cos;
      const weights = field.getSurfaceWeights(x, z);
      if (weights.green < 0.3) {
        pushTuft(x, z, seed);
      }
    }
  }

  source.thinInstanceSetBuffer("matrix", new Float32Array(matrices), 16, true);
};

const createBackdrop = (scene: Scene, field: FieldModel, material: StandardMaterial): Mesh => {
  const backdrop = MeshBuilder.CreateGround(
    "backdrop-hills",
    {
      width: BACKDROP_SIZE_M,
      height: BACKDROP_SIZE_M,
      subdivisions: BACKDROP_SUBDIVISIONS,
      updatable: true,
    },
    scene,
  );
  const positions = backdrop.getVerticesData(VertexBuffer.PositionKind);
  if (positions) {
    const halfWidth = field.terrainWidthM / 2;
    const halfLength = field.terrainLengthM / 2;
    for (let index = 0; index < positions.length; index += 3) {
      const x = positions[index];
      const z = positions[index + 2];
      // Inside the field the backdrop stays hidden under the terrain, coming
      // up to just below it at the boundary so no cliff shows; outside it
      // climbs into rolling hills.
      const edge = Math.max(Math.abs(x) / halfWidth, Math.abs(z) / halfLength);
      const sink = BACKDROP_SINK_M - (BACKDROP_SINK_M - BACKDROP_EDGE_SINK_M) * smoothstep(0.9, 1.0, edge);
      const rise = smoothstep(1.0, 1.8, edge) * HILL_RISE_M;
      const ridges =
        Math.sin(x * 0.011 + 1.3) * 12 +
        Math.cos(z * 0.009 - 0.7) * 10 +
        Math.sin((x + z) * 0.017) * 6;
      positions[index + 1] =
        field.getBaseHeight(x, z) - sink + rise + ridges * smoothstep(1.05, 1.5, edge);
    }
    backdrop.updateVerticesData(VertexBuffer.PositionKind, positions);
    backdrop.createNormals(false);
  }
  backdrop.material = material;
  backdrop.isPickable = false;
  backdrop.receiveShadows = false;
  return backdrop;
};

const createPin = (scene: Scene, field: FieldModel, materials: FieldMaterials): void => {
  const holeX = field.green.centerX;
  const holeZ = field.green.centerZ;
  const groundY = field.getHeight(holeX, holeZ);

  const cupHole = MeshBuilder.CreateDisc(
    "cup-hole",
    { radius: CUP_DIAMETER_M / 2, tessellation: 24 },
    scene,
  );
  cupHole.rotation.x = Math.PI / 2;
  cupHole.position.set(holeX, groundY + 0.006, holeZ);
  cupHole.material = materials.cupHole;

  const cupRim = MeshBuilder.CreateTorus(
    "cup-rim",
    { diameter: CUP_DIAMETER_M + 0.012, thickness: 0.014, tessellation: 24 },
    scene,
  );
  cupRim.position.set(holeX, groundY + 0.004, holeZ);
  cupRim.material = materials.cupRim;

  const flagPole = MeshBuilder.CreateCylinder(
    "flag-pole",
    { diameter: 0.03, height: FLAG_POLE_HEIGHT_M, tessellation: 12 },
    scene,
  );
  flagPole.position.set(holeX, groundY + FLAG_POLE_HEIGHT_M / 2, holeZ);
  flagPole.material = materials.pole;

  const knob = MeshBuilder.CreateSphere("flag-pole-knob", { diameter: 0.07, segments: 8 }, scene);
  knob.position.set(holeX, groundY + FLAG_POLE_HEIGHT_M + 0.02, holeZ);
  knob.material = materials.cupRim;

  const flag = MeshBuilder.CreatePlane(
    "pin-flag",
    { width: 0.72, height: 0.45 },
    scene,
  );
  // Pivot on the pole edge so the flutter swings the free end.
  flag.setPivotPoint(new Vector3(-0.36, 0, 0));
  flag.position.set(holeX + 0.36, groundY + FLAG_POLE_HEIGHT_M - 0.26, holeZ);
  flag.material = materials.flag;

  const restAngle = -0.35;
  scene.onBeforeRenderObservable.add(() => {
    const t = performance.now() * 0.001;
    flag.rotation.y = restAngle + Math.sin(t * 2.6) * 0.09 + Math.sin(t * 6.9 + 1.2) * 0.035;
  });
};

export const populateFieldProps = (
  scene: Scene,
  field: FieldModel,
  materials: FieldMaterials,
  shadowGenerator: ShadowGenerator | null,
): void => {
  [-1.2, 1.2].forEach((offset, index) => {
    const marker = MeshBuilder.CreateCylinder(
      `tee-marker-${index}`,
      {
        diameter: 0.38,
        height: 0.18,
        tessellation: 24,
      },
      scene,
    );
    marker.position.set(offset, field.getHeight(offset, 0.6) + 0.09, 0.6);
    marker.material = materials.teeMarker;
  });

  createPin(scene, field, materials);

  ["100m", "150m", "200m"].forEach((label, index) => {
    createDistanceMarker(scene, field, 100 + index * 50, label);
  });

  const backdrop = createBackdrop(scene, field, materials.backdrop);
  const backdropHeightAt = (x: number, z: number): number => {
    const insideField =
      Math.abs(x) <= field.terrainWidthM / 2 && Math.abs(z) <= field.terrainLengthM / 2;
    if (insideField) {
      return field.getHeight(x, z);
    }
    // Sample the backdrop mesh height by re-evaluating its formula through the
    // nearest vertex: cheap enough for a few dozen perimeter trees.
    const positions = backdrop.getVerticesData(VertexBuffer.PositionKind);
    if (!positions) {
      return 0;
    }
    // CreateGround lays rows out from +z to -z.
    const step = BACKDROP_SIZE_M / BACKDROP_SUBDIVISIONS;
    const column = Math.round((x + BACKDROP_SIZE_M / 2) / step);
    const row = BACKDROP_SUBDIVISIONS - Math.round((z + BACKDROP_SIZE_M / 2) / step);
    const vertex = (row * (BACKDROP_SUBDIVISIONS + 1) + column) * 3;
    return positions[vertex + 1] ?? 0;
  };

  const treeVariants = createTreeVariants(scene, materials);
  placeTrees(
    treeVariants,
    [
      ...corridorTreePlacements(field, 35, 180, 18, 44, 0.85, 1.2, 0),
      ...corridorTreePlacements(field, 180, 300, 20, 52, 0.9, 1.25, 100),
    ],
    "tree-corridor",
    field.getHeight,
    shadowGenerator,
  );
  placeTrees(
    treeVariants,
    perimeterTreePlacements(field),
    "tree-perimeter",
    backdropHeightAt,
    null,
  );

  const grassSource = createGrassSource(scene, materials.grassCard);
  scatterRoughGrass(field, grassSource);
};
