import {
  DynamicTexture,
  Mesh,
  MeshBuilder,
  Scene,
  StandardMaterial,
} from "@babylonjs/core";
import type { FieldMaterials } from "./materials";
import type { CourseFeature, FieldModel } from "./terrain";

const hash = (seed: number): number => {
  const value = Math.sin(seed * 12.9898) * 43758.5453;
  return value - Math.floor(value);
};

const placePatch = (
  scene: Scene,
  name: string,
  feature: CourseFeature,
  field: FieldModel,
  material: StandardMaterial,
  yOffset: number,
): Mesh => {
  const patch = MeshBuilder.CreateDisc(
    name,
    {
      radius: feature.radiusZ,
      tessellation: 64,
    },
    scene,
  );
  patch.rotation.x = Math.PI / 2;
  patch.rotation.z = feature.angleRad;
  patch.scaling.x = feature.radiusX / feature.radiusZ;
  patch.position.set(
    feature.centerX,
    field.getHeight(feature.centerX, feature.centerZ) + yOffset,
    feature.centerZ,
  );
  patch.material = material;
  return patch;
};

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
  context.fillText(label, 128, 48);
  texture.update(false);
  texture.hasAlpha = true;

  const material = new StandardMaterial(`distance-marker-material-${label}`, scene);
  material.diffuseTexture = texture;
  material.emissiveColor.set(0.12, 0.14, 0.11);
  material.specularColor.set(0, 0, 0);
  marker.material = material;
  return marker;
};

const createTreeSource = (
  scene: Scene,
  name: string,
  diameter: number,
  material: StandardMaterial,
): Mesh => {
  const source = MeshBuilder.CreateSphere(
    name,
    { diameter, segments: 8 },
    scene,
  );
  source.material = material;
  source.isVisible = false;
  return source;
};

const populateTreeBand = (
  field: FieldModel,
  source: Mesh,
  startZ: number,
  endZ: number,
  count: number,
  lateralOffset: number,
  scaleMin: number,
  scaleMax: number,
): void => {
  for (let index = 0; index < count; index += 1) {
    const t = count <= 1 ? 0 : index / (count - 1);
    const z = startZ + (endZ - startZ) * t + (hash(index * 17.3) - 0.5) * 6;
    const center = field.getCorridorCenterX(z);
    const side = index % 2 === 0 ? -1 : 1;
    const x = center + side * (lateralOffset + hash(index * 9.1) * 34);
    const scale = scaleMin + hash(index * 4.7) * (scaleMax - scaleMin);
    const instance = source.createInstance(`${source.name}-instance-${index}`);
    instance.position.set(x, field.getHeight(x, z) + scale * 0.45, z);
    instance.scaling.set(scale, scale * 0.82, scale);
  }
};

const createGrassSource = (scene: Scene, material: StandardMaterial): Mesh => {
  const firstBlade = MeshBuilder.CreatePlane(
    "grass-blade-a",
    { width: 0.36, height: 1.3 },
    scene,
  );
  firstBlade.material = material;
  firstBlade.position.y = 0.65;

  const secondBlade = firstBlade.clone("grass-blade-b")!;
  secondBlade.rotation.y = Math.PI / 2;

  const merged = Mesh.MergeMeshes([firstBlade, secondBlade], true, true, undefined, false, true);
  if (!merged) {
    throw new Error("Failed to create grass source mesh.");
  }
  merged.isVisible = false;
  return merged;
};

const populateGrassZone = (
  field: FieldModel,
  source: Mesh,
  startZ: number,
  endZ: number,
  halfWidth: number,
  rows: number,
  columns: number,
): void => {
  for (let row = 0; row < rows; row += 1) {
    const z = startZ + ((endZ - startZ) / Math.max(1, rows - 1)) * row;
    for (let column = 0; column < columns; column += 1) {
      const lateral = ((column / Math.max(1, columns - 1)) - 0.5) * halfWidth * 2;
      const jitterX = (hash(row * 31 + column * 7) - 0.5) * 0.8;
      const jitterZ = (hash(row * 13 + column * 19) - 0.5) * 1.2;
      const x = field.getCorridorCenterX(z) + lateral + jitterX;
      const sampleZ = z + jitterZ;
      const surface = field.getSurfaceType(x, sampleZ);

      if (surface === "rough" || surface === "bunker") {
        continue;
      }

      const instance = source.createInstance(`grass-${row}-${column}-${startZ}`);
      const heightScale = 0.7 + hash(row * 29 + column * 11) * 0.55;
      instance.position.set(x, field.getHeight(x, sampleZ), sampleZ);
      instance.scaling.set(heightScale, heightScale, heightScale);
      instance.rotation.y = hash(row * 17 + column * 5) * Math.PI;
    }
  }
};

export const populateFieldProps = (
  scene: Scene,
  field: FieldModel,
  materials: FieldMaterials,
): void => {
  placePatch(scene, "tee-patch", {
    centerX: 0,
    centerZ: 0,
    radiusX: 10.5,
    radiusZ: 8.8,
    angleRad: 0,
  }, field, materials.teePatch, 0.04);

  placePatch(scene, "green-patch", field.green, field, materials.greenPatch, 0.045);
  field.bunkers.forEach((bunker, index) => {
    placePatch(scene, `bunker-patch-${index}`, bunker, field, materials.bunkerPatch, 0.03);
  });

  const teeMarkerMaterial = new StandardMaterial("tee-marker-material", scene);
  teeMarkerMaterial.diffuseColor.set(0.98, 0.97, 0.93);
  teeMarkerMaterial.specularColor.set(0.12, 0.12, 0.12);

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
    marker.position.set(offset, field.getHeight(offset, 0.6) + 0.12, 0.6);
    marker.material = teeMarkerMaterial;
  });

  const cup = MeshBuilder.CreateCylinder(
    "hole-cup",
    {
      diameter: 0.12,
      height: 0.16,
      tessellation: 18,
    },
    scene,
  );
  cup.position.set(
    field.green.centerX,
    field.getHeight(field.green.centerX, field.green.centerZ) + 0.02,
    field.green.centerZ,
  );
  cup.material = materials.cup;

  const flagPole = MeshBuilder.CreateCylinder(
    "flag-pole",
    {
      diameter: 0.08,
      height: 2.4,
      tessellation: 12,
    },
    scene,
  );
  flagPole.position.set(
    field.green.centerX,
    field.getHeight(field.green.centerX, field.green.centerZ) + 1.2,
    field.green.centerZ,
  );
  flagPole.material = materials.pole;

  const flag = MeshBuilder.CreatePlane(
    "pin-flag",
    {
      width: 0.9,
      height: 0.56,
    },
    scene,
  );
  flag.position.set(
    field.green.centerX + 0.45,
    field.getHeight(field.green.centerX, field.green.centerZ) + 2.1,
    field.green.centerZ,
  );
  flag.rotation.y = -0.25;
  flag.material = materials.flag;

  ["100m", "150m", "200m"].forEach((label, index) => {
    createDistanceMarker(scene, field, 100 + index * 50, label);
  });

  const farTreeSource = createTreeSource(scene, "tree-source-far", 8.2, materials.treeLeafFar);
  const midTreeSource = createTreeSource(scene, "tree-source-mid", 10, materials.treeLeafMid);
  const nearTreeSource = createTreeSource(scene, "tree-source-near", 12.5, materials.treeLeafNear);

  populateTreeBand(field, nearTreeSource, 35, 180, 16, 42, 0.8, 1.15);
  populateTreeBand(field, midTreeSource, 180, 300, 18, 58, 0.9, 1.2);
  populateTreeBand(field, farTreeSource, 300, 360, 16, 88, 0.9, 1.18);

  const backgroundHill = MeshBuilder.CreateGround(
    "background-hill",
    { width: 720, height: 80, subdivisions: 16 },
    scene,
  );
  backgroundHill.position.z = 362;
  backgroundHill.position.y = 7;
  const hillMaterial = new StandardMaterial("background-hill-material", scene);
  hillMaterial.diffuseColor.set(0.39, 0.5, 0.34);
  hillMaterial.specularColor.set(0, 0, 0);
  backgroundHill.material = hillMaterial;

  const grassSource = createGrassSource(scene, materials.grassCard);
  populateGrassZone(field, grassSource, -4, 38, 12, 14, 22);
  populateGrassZone(field, grassSource, 208, 280, 18, 16, 26);
};
