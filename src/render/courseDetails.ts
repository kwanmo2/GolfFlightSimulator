import {
  Color3,
  Mesh,
  MeshBuilder,
  Scene,
  StandardMaterial,
  Vector3,
} from "@babylonjs/core";
import { PALETTE, toColor3 } from "./palette";
import type { FieldModel } from "./terrain";

/**
 * The water plane reaches past the pond outline and tucks under the bank, so
 * the terrain itself draws the shoreline. It has to cover the outline's
 * outward lobes (see CourseFeature.wobble) with some margin.
 */
const WATER_PLANE_REACH = 1.2;
const WATER_TESSELLATION = 96;
const WATER_ALPHA = 0.9;
const WATER_SPECULAR = 0.45;
const WATER_SPECULAR_POWER = 64;

/** Distance between cart path samples along the hole, metres. */
const CART_PATH_STEP_M = 1.5;
/** Lift above the terrain so the path does not flicker against it. */
const CART_PATH_LIFT_M = 0.05;

const createPondWater = (scene: Scene, field: FieldModel): Mesh => {
  const { pond } = field;
  const water = MeshBuilder.CreateDisc(
    "pond-water",
    { radius: 1, tessellation: WATER_TESSELLATION },
    scene,
  );
  water.rotation.x = Math.PI / 2;
  water.bakeCurrentTransformIntoVertices();
  water.scaling.set(pond.radiusX * WATER_PLANE_REACH, 1, pond.radiusZ * WATER_PLANE_REACH);
  // CourseFeature's local X axis points along (cos a, sin a) in world XZ,
  // which is a Babylon Y rotation of -a.
  water.rotation.y = -pond.angleRad;
  water.position.set(pond.centerX, field.waterLevelY, pond.centerZ);

  const material = new StandardMaterial("pond-water-material", scene);
  material.diffuseColor = toColor3(PALETTE.surface.water);
  material.specularColor = new Color3(WATER_SPECULAR, WATER_SPECULAR, WATER_SPECULAR);
  material.specularPower = WATER_SPECULAR_POWER;
  material.alpha = WATER_ALPHA;
  material.backFaceCulling = false;
  water.material = material;
  water.isPickable = false;
  water.receiveShadows = true;
  return water;
};

/**
 * A ribbon draped over the terrain from the tee to the green. It is purely
 * decorative: the physics treats the ground under it as rough.
 */
const createCartPath = (scene: Scene, field: FieldModel): Mesh => {
  const left: Vector3[] = [];
  const right: Vector3[] = [];
  const halfWidth = field.cartPathHalfWidthM;

  for (let z = field.cartPathStartZ; z <= field.cartPathEndZ; z += CART_PATH_STEP_M) {
    const x = field.getCartPathX(z);
    const ahead = field.getCartPathX(z + CART_PATH_STEP_M) - x;
    const tangentLength = Math.hypot(ahead, CART_PATH_STEP_M);
    // Unit vector across the path, pointing to its right (toward +X).
    const acrossX = CART_PATH_STEP_M / tangentLength;
    const acrossZ = -ahead / tangentLength;

    const leftX = x - acrossX * halfWidth;
    const leftZ = z - acrossZ * halfWidth;
    const rightX = x + acrossX * halfWidth;
    const rightZ = z + acrossZ * halfWidth;
    left.push(new Vector3(leftX, field.getHeight(leftX, leftZ) + CART_PATH_LIFT_M, leftZ));
    right.push(new Vector3(rightX, field.getHeight(rightX, rightZ) + CART_PATH_LIFT_M, rightZ));
  }

  const path = MeshBuilder.CreateRibbon(
    "cart-path",
    { pathArray: [left, right], sideOrientation: Mesh.DOUBLESIDE },
    scene,
  );
  const material = new StandardMaterial("cart-path-material", scene);
  material.diffuseColor = toColor3(PALETTE.surface.cartPath);
  material.specularColor = Color3.Black();
  material.zOffset = -2;
  path.material = material;
  path.isPickable = false;
  path.receiveShadows = true;
  return path;
};

/** Hazards and furniture that sit on the course surface: the pond and the cart path. */
export const createCourseDetails = (scene: Scene, field: FieldModel): void => {
  createPondWater(scene, field);
  createCartPath(scene, field);
};
