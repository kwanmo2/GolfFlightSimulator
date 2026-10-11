import { Mesh, MeshBuilder, Scene, Vector3 } from "@babylonjs/core";
import { createPaintedMaterial } from "./materials";
import { PALETTE } from "./palette";
import type { FieldModel } from "./terrain";

/**
 * The water plane reaches past the pond outline and tucks under the bank, so
 * the terrain itself draws the shoreline. It has to cover the outline's
 * outward lobes (see CourseFeature.wobble) with some margin.
 */
const WATER_PLANE_REACH = 1.2;
const WATER_TESSELLATION = 96;
const WATER_ALPHA = 0.9;
/** Calm water: a glossy surface that mirrors a slightly blurred sky. */
const WATER_ROUGHNESS = 0.06;
const CART_PATH_ROUGHNESS = 0.85;

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

  const material = createPaintedMaterial(scene, "pond-water-material", PALETTE.surface.water, WATER_ROUGHNESS);
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
  const material = createPaintedMaterial(scene, "cart-path-material", PALETTE.surface.cartPath, CART_PATH_ROUGHNESS);
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
