import {
  Color3,
  DynamicTexture,
  Mesh,
  MeshBuilder,
  Scene,
  StandardMaterial,
  Texture,
  Vector3,
  VertexBuffer,
} from "@babylonjs/core";
import { PALETTE, toColor3 } from "./palette";
import { hash } from "./proceduralNoise";

// Big enough to enclose the backdrop hills; fog hides the far side anyway.
const SKY_DOME_DIAMETER_M = 2400;
const SKY_DOME_SEGMENTS = 32;
const SKY_TEXTURE_SIZE = 1024;

// Low-poly clouds float in a ring outside the field, below the dome.
const CLOUD_COUNT = 14;
const CLOUD_RING_RADIUS_M = 780;
const CLOUD_RING_JITTER_M = 180;
const CLOUD_MIN_ALTITUDE_M = 150;
const CLOUD_ALTITUDE_RANGE_M = 110;
const CLOUD_PUFF_COUNT = 5;
const CLOUD_PUFF_RADIUS_M = 22;
/** Clouds are unlit so they stay clean white; this keeps a hint of the sky in their base. */
const CLOUD_SHADE_EMISSIVE = 0.92;

/**
 * Texture coordinate on the sky dome that faces a world direction, expressed
 * as (u, v) with v = 0 at the zenith and v = 1 at the nadir. Reading the dome's
 * own vertex data avoids depending on the sphere builder's UV convention.
 */
const findSkyUvTowards = (dome: Mesh, direction: Vector3): { u: number; v: number } => {
  const positions = dome.getVerticesData(VertexBuffer.PositionKind);
  const uvs = dome.getVerticesData(VertexBuffer.UVKind);
  if (!positions || !uvs) {
    return { u: 0.5, v: 0.2 };
  }

  const target = direction.normalizeToNew();
  let bestDot = -Infinity;
  let bestIndex = 0;
  let topV = 0;
  let topY = -Infinity;
  let bottomV = 1;
  let bottomY = Infinity;

  for (let index = 0; index < positions.length / 3; index += 1) {
    const x = positions[index * 3];
    const y = positions[index * 3 + 1];
    const z = positions[index * 3 + 2];
    const length = Math.hypot(x, y, z) || 1;
    const dot = (x * target.x + y * target.y + z * target.z) / length;
    if (dot > bestDot) {
      bestDot = dot;
      bestIndex = index;
    }
    if (y > topY) {
      topY = y;
      topV = uvs[index * 2 + 1];
    }
    if (y < bottomY) {
      bottomY = y;
      bottomV = uvs[index * 2 + 1];
    }
  }

  const v = uvs[bestIndex * 2 + 1];
  return {
    u: uvs[bestIndex * 2],
    v: (v - topV) / (bottomV - topV || 1),
  };
};

/**
 * Equirectangular gradient for the dome: zenith at the top of the canvas,
 * horizon at mid height, plus a soft sun glow. The horizon colour matches the
 * scene fog so distant ground fades into it.
 */
const createSkyTexture = (scene: Scene, sunU: number, sunV: number): DynamicTexture => {
  const size = SKY_TEXTURE_SIZE;
  const texture = new DynamicTexture("field-sky", { width: size, height: size }, scene, false);
  const context = texture.getContext() as unknown as CanvasRenderingContext2D;

  const gradient = context.createLinearGradient(0, 0, 0, size);
  gradient.addColorStop(0, PALETTE.sky.zenith);
  gradient.addColorStop(0.3, PALETTE.sky.mid);
  gradient.addColorStop(0.49, PALETTE.sky.horizon);
  gradient.addColorStop(0.53, PALETTE.sky.belowHorizon);
  gradient.addColorStop(1, PALETTE.sky.belowHorizon);
  context.fillStyle = gradient;
  context.fillRect(0, 0, size, size);

  const sunX = sunU * size;
  const sunY = sunV * size;
  const glow = context.createRadialGradient(sunX, sunY, 0, sunX, sunY, size * 0.28);
  glow.addColorStop(0, "rgba(255, 250, 232, 0.9)");
  glow.addColorStop(0.1, "rgba(255, 246, 222, 0.4)");
  glow.addColorStop(1, "rgba(255, 244, 220, 0)");
  context.fillStyle = glow;
  context.fillRect(0, 0, size, size);

  texture.update(false);
  texture.wrapU = Texture.CLAMP_ADDRESSMODE;
  texture.wrapV = Texture.CLAMP_ADDRESSMODE;
  return texture;
};

/** One cloud: a few flat-shaded icospheres squashed into a flat-bottomed puff. */
const createCloud = (scene: Scene, index: number, material: StandardMaterial): Mesh => {
  const puffs: Mesh[] = [];
  for (let puff = 0; puff < CLOUD_PUFF_COUNT; puff += 1) {
    const seed = index * 17 + puff * 3;
    const radius = CLOUD_PUFF_RADIUS_M * (puff === 0 ? 1.2 : 0.6 + hash(seed) * 0.5);
    const sphere = MeshBuilder.CreateIcoSphere(
      `cloud-${index}-puff-${puff}`,
      { radius, subdivisions: 1, flat: true },
      scene,
    );
    const spread = (puff - (CLOUD_PUFF_COUNT - 1) / 2) * CLOUD_PUFF_RADIUS_M * 0.9;
    sphere.position.set(spread, radius * 0.25 * hash(seed + 1), (hash(seed + 2) - 0.5) * radius);
    sphere.scaling.y = 0.55;
    puffs.push(sphere);
  }
  const cloud = Mesh.MergeMeshes(puffs, true, true);
  if (!cloud) {
    throw new Error(`Failed to merge cloud ${index}.`);
  }
  cloud.name = `cloud-${index}`;
  cloud.material = material;
  cloud.isPickable = false;
  return cloud;
};

const createClouds = (scene: Scene): void => {
  const material = new StandardMaterial("cloud-material", scene);
  material.diffuseColor = toColor3(PALETTE.sky.cloudShade);
  material.emissiveColor = toColor3(PALETTE.sky.cloud).scale(CLOUD_SHADE_EMISSIVE);
  material.specularColor = Color3.Black();
  material.fogEnabled = false;

  for (let index = 0; index < CLOUD_COUNT; index += 1) {
    const cloud = createCloud(scene, index, material);
    const angle = (index / CLOUD_COUNT) * Math.PI * 2 + hash(index + 0.3) * 0.3;
    const distance = CLOUD_RING_RADIUS_M + (hash(index + 0.6) - 0.5) * CLOUD_RING_JITTER_M;
    cloud.position.set(
      Math.cos(angle) * distance,
      CLOUD_MIN_ALTITUDE_M + hash(index + 0.9) * CLOUD_ALTITUDE_RANGE_M,
      Math.sin(angle) * distance,
    );
    cloud.rotation.y = -angle + Math.PI / 2;
    const scale = 0.8 + hash(index + 1.2) * 0.6;
    cloud.scaling.set(scale, scale, scale);
  }
};

/**
 * Gradient sky dome plus a ring of low-poly clouds. `sunDirection` is the
 * direction the sunlight travels, so the glow is painted on the opposite side.
 */
export const createSky = (scene: Scene, sunDirection: Vector3): void => {
  const dome = MeshBuilder.CreateSphere(
    "sky-dome",
    {
      diameter: SKY_DOME_DIAMETER_M,
      segments: SKY_DOME_SEGMENTS,
      sideOrientation: Mesh.BACKSIDE,
    },
    scene,
  );
  dome.isPickable = false;
  const sunUv = findSkyUvTowards(dome, sunDirection.scale(-1));

  const material = new StandardMaterial("sky-material", scene);
  material.emissiveTexture = createSkyTexture(scene, sunUv.u, sunUv.v);
  material.diffuseColor = Color3.Black();
  material.specularColor = Color3.Black();
  material.disableLighting = true;
  material.fogEnabled = false;
  dome.material = material;

  createClouds(scene);
};
