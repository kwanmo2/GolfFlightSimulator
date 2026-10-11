import "@babylonjs/loaders/glTF";
import { LoadAssetContainerAsync, Mesh, Scene, VertexBuffer } from "@babylonjs/core";
import type { Material } from "@babylonjs/core";
import { PALETTE, toLinearColor3 } from "./palette";

/** CC0 Kenney Nature Kit models; see public/models/LICENSE.md. */
const MODEL_ROOT = "/models/";

/** Palette colour for each material name used by the kit. */
type KitMaterialColors = Record<string, string>;

const DEFAULT_KIT_COLORS: KitMaterialColors = {
  leafsGreen: PALETTE.vegetation.leafMid,
  leafsDark: PALETTE.vegetation.conifer,
  woodBark: PALETTE.vegetation.trunk,
  woodBarkDark: PALETTE.vegetation.trunk,
  grass: PALETTE.vegetation.grass,
  colorYellow: PALETTE.vegetation.flowerYellow,
  colorPurple: PALETTE.vegetation.flowerWhite,
};
const FALLBACK_COLOR = PALETTE.vegetation.leafMid;

/**
 * Each part is darkened toward its underside so canopies and clumps read as
 * volumes even in flat light. Brightness runs from this at the bottom of a part...
 */
const PART_SHADE_BOTTOM = 0.74;
/** ...to this at the top. */
const PART_SHADE_TOP = 1.06;

export interface ModelSpec {
  file: string;
  /** Overrides for DEFAULT_KIT_COLORS, keyed by kit material name. */
  colors?: KitMaterialColors;
  /** Horizontal stretch applied after normalising to unit height, for fuller canopies. */
  widthScale?: number;
}

/**
 * Paint one loaded part with its palette colour as vertex colours, graded from
 * a darker base to a lighter top.
 */
const paintPart = (mesh: Mesh, colors: KitMaterialColors): void => {
  const positions = mesh.getVerticesData(VertexBuffer.PositionKind);
  if (!positions) {
    return;
  }
  const materialName = mesh.material?.name ?? "";
  const base = toLinearColor3(colors[materialName] ?? FALLBACK_COLOR);

  let minY = Infinity;
  let maxY = -Infinity;
  for (let index = 1; index < positions.length; index += 3) {
    minY = Math.min(minY, positions[index]);
    maxY = Math.max(maxY, positions[index]);
  }
  const range = maxY - minY || 1;

  const vertexColors = new Float32Array((positions.length / 3) * 4);
  for (let vertex = 0; vertex < positions.length / 3; vertex += 1) {
    const t = (positions[vertex * 3 + 1] - minY) / range;
    const shade = PART_SHADE_BOTTOM + (PART_SHADE_TOP - PART_SHADE_BOTTOM) * t;
    vertexColors[vertex * 4] = base.r * shade;
    vertexColors[vertex * 4 + 1] = base.g * shade;
    vertexColors[vertex * 4 + 2] = base.b * shade;
    vertexColors[vertex * 4 + 3] = 1;
  }
  mesh.setVerticesData(VertexBuffer.ColorKind, vertexColors);
};

/**
 * Baking the glTF handedness mirror leaves some models wound inside out. The
 * file's vertex normals survive the bake correctly, so count how many
 * triangles face against their normals and flip the whole mesh if most do.
 */
const orientFacesToNormals = (mesh: Mesh): void => {
  const positions = mesh.getVerticesData(VertexBuffer.PositionKind);
  const normals = mesh.getVerticesData(VertexBuffer.NormalKind);
  const indices = mesh.getIndices();
  if (!positions || !normals || !indices) {
    return;
  }

  let agreeing = 0;
  for (let triangle = 0; triangle < indices.length; triangle += 3) {
    const [a, b, c] = [indices[triangle] * 3, indices[triangle + 1] * 3, indices[triangle + 2] * 3];
    const e1 = [positions[b] - positions[a], positions[b + 1] - positions[a + 1], positions[b + 2] - positions[a + 2]];
    const e2 = [positions[c] - positions[a], positions[c + 1] - positions[a + 1], positions[c + 2] - positions[a + 2]];
    // Babylon's default front faces are those whose e1 x e2 points out of them.
    const face = [e1[1] * e2[2] - e1[2] * e2[1], e1[2] * e2[0] - e1[0] * e2[2], e1[0] * e2[1] - e1[1] * e2[0]];
    const normal = [normals[a] + normals[b] + normals[c], normals[a + 1] + normals[b + 1] + normals[c + 1], normals[a + 2] + normals[b + 2] + normals[c + 2]];
    if (face[0] * normal[0] + face[1] * normal[1] + face[2] * normal[2] > 0) {
      agreeing += 1;
    }
  }
  if (agreeing < indices.length / 6) {
    mesh.flipFaces(false);
  }
};

/**
 * Load one model as a single mesh: every part is baked into world space,
 * vertex-coloured from the palette and merged, then scaled so the model is
 * 1 m tall with its base at y = 0. Placement code then scales by the real
 * height it wants. The kit's own materials are discarded.
 */
const loadModel = async (scene: Scene, spec: ModelSpec, material: Material): Promise<Mesh> => {
  const container = await LoadAssetContainerAsync(`${MODEL_ROOT}${spec.file}`, scene);
  container.addAllToScene();

  const colors = { ...DEFAULT_KIT_COLORS, ...spec.colors };
  const parts = container.meshes.filter(
    (mesh): mesh is Mesh => mesh instanceof Mesh && mesh.getTotalVertices() > 0,
  );
  parts.forEach((part) => paintPart(part, colors));

  // MergeMeshes bakes each part's world matrix, including the glTF root's
  // handedness mirror, so the result sits directly in Babylon's world space.
  const merged = Mesh.MergeMeshes(parts, false, true);
  container.dispose();
  if (!merged) {
    throw new Error(`Model ${spec.file} has no mergeable geometry.`);
  }

  orientFacesToNormals(merged);

  merged.refreshBoundingInfo();
  const { minimum, maximum } = merged.getBoundingInfo().boundingBox;
  const height = maximum.y - minimum.y || 1;
  const widthScale = (spec.widthScale ?? 1) / height;
  merged.position.set(0, -minimum.y / height, 0);
  merged.scaling.set(widthScale, 1 / height, widthScale);
  merged.bakeCurrentTransformIntoVertices();

  merged.name = `model-${spec.file.replace(/\.glb$/, "")}`;
  merged.material = material;
  merged.isPickable = false;
  return merged;
};

/** Load several models in parallel, keeping their order. */
export const loadModels = (scene: Scene, specs: ModelSpec[], material: Material): Promise<Mesh[]> =>
  Promise.all(specs.map((spec) => loadModel(scene, spec, material)));
