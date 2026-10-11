import {
  DynamicTexture,
  Mesh,
  MeshBuilder,
  Scene,
  StandardMaterial,
  Vector3,
  VertexBuffer,
} from "@babylonjs/core";
import type { Material } from "@babylonjs/core";
import { createPaintedMaterial } from "./materials";
import type { FieldMaterials } from "./materials";
import { PALETTE } from "./palette";
import { smoothstep } from "./proceduralNoise";
import type { FieldModel } from "./terrain";
import type { HeightResolver } from "./vegetation";

// Backdrop: hills rise beyond the playable field and hide its edge.
const BACKDROP_SIZE_M = 2000;
const BACKDROP_SUBDIVISIONS = 96;
/**
 * How far below the landform the backdrop sits inside the field: deeper than
 * any bunker bowl, pond bed or bank cut, so it never pokes through.
 */
const BACKDROP_SINK_M = 15;
const BACKDROP_EDGE_SINK_M = 0.15;
const HILL_RISE_M = 55;

const FLAG_POLE_HEIGHT_M = 2.3;
const CUP_DIAMETER_M = 0.108;

const TEE_MARKER_DIAMETER_M = 0.3;
const TEE_MARKER_OFFSET_X_M = 1.2;
const TEE_MARKER_Z_M = 0.6;

// Distance markers: a coloured disc on the centre line plus a labelled post
// just off the left edge of the fairway, where it never hides the ball flight.
const DISTANCE_MARKERS: Array<{ distanceM: number; color: string }> = [
  { distanceM: 100, color: PALETTE.props.marker100 },
  { distanceM: 150, color: PALETTE.props.marker150 },
  { distanceM: 200, color: PALETTE.props.marker200 },
];
const MARKER_DISC_RADIUS_M = 0.9;
const MARKER_POST_HEIGHT_M = 2.2;
const MARKER_POST_DIAMETER_M = 0.12;
const MARKER_POST_EDGE_OFFSET_M = 1.5;
const MARKER_LABEL_WIDTH_M = 2.8;
const MARKER_LABEL_HEIGHT_M = 1.2;
const MARKER_LABEL_TEXTURE = { width: 256, height: 110 };

const drawRoundedRect = (
  context: CanvasRenderingContext2D,
  x: number,
  y: number,
  width: number,
  height: number,
  radius: number,
): void => {
  context.beginPath();
  context.moveTo(x + radius, y);
  context.arcTo(x + width, y, x + width, y + height, radius);
  context.arcTo(x + width, y + height, x, y + height, radius);
  context.arcTo(x, y + height, x, y, radius);
  context.arcTo(x, y, x + width, y, radius);
  context.closePath();
};

const createMarkerLabelMaterial = (scene: Scene, label: string, color: string): StandardMaterial => {
  const { width, height } = MARKER_LABEL_TEXTURE;
  const texture = new DynamicTexture(`distance-marker-label-${label}`, { width, height }, scene, true);
  const context = texture.getContext() as unknown as CanvasRenderingContext2D;
  context.clearRect(0, 0, width, height);
  drawRoundedRect(context, 4, 4, width - 8, height - 8, 22);
  context.fillStyle = PALETTE.props.markerLabel;
  context.fill();
  context.lineWidth = 8;
  context.strokeStyle = color;
  context.stroke();
  context.fillStyle = PALETTE.props.flagText;
  context.font = "bold 58px Segoe UI, Arial, sans-serif";
  context.textAlign = "center";
  context.textBaseline = "middle";
  context.fillText(label, width / 2, height / 2 + 2);
  texture.update(true);
  texture.hasAlpha = true;

  const material = new StandardMaterial(`distance-marker-label-material-${label}`, scene);
  material.diffuseTexture = texture;
  material.emissiveTexture = texture;
  material.useAlphaFromDiffuseTexture = true;
  material.disableLighting = true;
  material.backFaceCulling = false;
  return material;
};

const createDistanceMarker = (
  scene: Scene,
  field: FieldModel,
  distanceM: number,
  color: string,
  postMaterial: Material,
): void => {
  const label = `${distanceM}m`;
  const centerX = field.getCorridorCenterX(distanceM);

  const disc = MeshBuilder.CreateDisc(
    `distance-marker-disc-${label}`,
    { radius: MARKER_DISC_RADIUS_M, tessellation: 32 },
    scene,
  );
  disc.rotation.x = Math.PI / 2;
  disc.position.set(centerX, field.getHeight(centerX, distanceM) + 0.03, distanceM);
  disc.material = createPaintedMaterial(scene, `distance-marker-disc-material-${label}`, color);
  disc.isPickable = false;

  const postX = centerX - field.getFairwayHalfWidth(distanceM) - MARKER_POST_EDGE_OFFSET_M;
  const groundY = field.getHeight(postX, distanceM);
  const post = MeshBuilder.CreateCylinder(
    `distance-marker-post-${label}`,
    { diameter: MARKER_POST_DIAMETER_M, height: MARKER_POST_HEIGHT_M, tessellation: 10 },
    scene,
  );
  post.position.set(postX, groundY + MARKER_POST_HEIGHT_M / 2, distanceM);
  post.material = postMaterial;
  post.isPickable = false;

  const sign = MeshBuilder.CreatePlane(
    `distance-marker-label-${label}`,
    { width: MARKER_LABEL_WIDTH_M, height: MARKER_LABEL_HEIGHT_M },
    scene,
  );
  sign.billboardMode = Mesh.BILLBOARDMODE_ALL;
  sign.position.set(postX, groundY + MARKER_POST_HEIGHT_M + MARKER_LABEL_HEIGHT_M / 2, distanceM);
  sign.material = createMarkerLabelMaterial(scene, label, color);
  sign.isPickable = false;
};

const createBackdrop = (scene: Scene, field: FieldModel, material: Material): Mesh => {
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

/**
 * Build the static course props and return a height lookup that also covers
 * the backdrop hills, for anything planted outside the playable field.
 */
export const populateFieldProps = (
  scene: Scene,
  field: FieldModel,
  materials: FieldMaterials,
): HeightResolver => {
  [-TEE_MARKER_OFFSET_X_M, TEE_MARKER_OFFSET_X_M].forEach((offset, index) => {
    const marker = MeshBuilder.CreateSphere(
      `tee-marker-${index}`,
      { diameter: TEE_MARKER_DIAMETER_M, segments: 12 },
      scene,
    );
    marker.position.set(
      offset,
      field.getHeight(offset, TEE_MARKER_Z_M) + TEE_MARKER_DIAMETER_M * 0.4,
      TEE_MARKER_Z_M,
    );
    marker.material = materials.teeMarker;
  });

  createPin(scene, field, materials);

  const postMaterial = createPaintedMaterial(scene, "distance-marker-post-material", PALETTE.props.markerPost);
  DISTANCE_MARKERS.forEach(({ distanceM, color }) => {
    createDistanceMarker(scene, field, distanceM, color, postMaterial);
  });

  const backdrop = createBackdrop(scene, field, materials.backdrop);
  const positions = backdrop.getVerticesData(VertexBuffer.PositionKind);
  return (x, z) => {
    const insideField =
      Math.abs(x) <= field.terrainWidthM / 2 && Math.abs(z) <= field.terrainLengthM / 2;
    if (insideField || !positions) {
      return field.getHeight(x, z);
    }
    // Nearest backdrop vertex: cheap enough for a few dozen perimeter trees.
    // CreateGround lays rows out from +z to -z.
    const step = BACKDROP_SIZE_M / BACKDROP_SUBDIVISIONS;
    const column = Math.round((x + BACKDROP_SIZE_M / 2) / step);
    const row = BACKDROP_SUBDIVISIONS - Math.round((z + BACKDROP_SIZE_M / 2) / step);
    const vertex = (row * (BACKDROP_SUBDIVISIONS + 1) + column) * 3;
    return positions[vertex + 1] ?? 0;
  };
};
