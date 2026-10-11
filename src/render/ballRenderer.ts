import {
  Color3,
  DynamicTexture,
  Mesh,
  MeshBuilder,
  FresnelParameters,
  Scene,
  StandardMaterial,
  Texture,
  Vector3,
} from "@babylonjs/core";
import type { SimulationFrame } from "../types/simulation";
import { PALETTE, toColor3 } from "./palette";

export interface BallRenderer {
  mesh: Mesh;
  update(frame: SimulationFrame): void;
}

/** Terrain height at a point, in world Y. Simulated positions are already in world space. */
export type GroundHeightResolver = (x: number, z: number) => number;

const BALL_SPECULAR = 0.35;
const BALL_SPECULAR_POWER = 48;
const BALL_EMISSIVE = 0.22;
const BALL_RIM_POWER = 2.5;
const BALL_DIMPLE_STRENGTH = 0.5;
const BALL_SHADOW_ALPHA = 0.28;

const createDimpleNormalTexture = (
  scene: Scene,
  size = 256,
): DynamicTexture => {
  const texture = new DynamicTexture(
    "golf-ball-dimple-normal",
    { width: size, height: size },
    scene,
    false,
  );
  const context = texture.getContext() as unknown as CanvasRenderingContext2D;
  const image = context.createImageData(size, size);
  const heightField = new Float32Array(size * size);

  for (let y = 0; y < size; y += 1) {
    const rowOffset = (y % 26) < 13 ? 0 : 10;
    for (let x = 0; x < size; x += 1) {
      const centerX = ((x + rowOffset) % 20) + Math.floor(x / 20) * 20;
      const centerY = (y % 22) + Math.floor(y / 22) * 22;
      const distanceX = (x - centerX + size) % 20;
      const wrappedX = distanceX > 10 ? distanceX - 20 : distanceX;
      const distanceY = (y - centerY + size) % 22;
      const wrappedY = distanceY > 11 ? distanceY - 22 : distanceY;
      const distance = Math.sqrt(wrappedX * wrappedX + wrappedY * wrappedY);

      if (distance < 5.2) {
        const normalized = 1 - distance / 5.2;
        heightField[y * size + x] -= normalized * normalized * 0.95;
      }
    }
  }

  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const index = y * size + x;
      const left = heightField[y * size + ((x - 1 + size) % size)];
      const right = heightField[y * size + ((x + 1) % size)];
      const up = heightField[((y - 1 + size) % size) * size + x];
      const down = heightField[((y + 1) % size) * size + x];

      const dx = (right - left) * 3.1;
      const dy = (down - up) * 3.1;
      const nz = 1;
      const length = Math.sqrt(dx * dx + dy * dy + nz * nz) || 1;

      const pixel = index * 4;
      image.data[pixel] = Math.round(((dx / length) * 0.5 + 0.5) * 255);
      image.data[pixel + 1] = Math.round((((-dy) / length) * 0.5 + 0.5) * 255);
      image.data[pixel + 2] = Math.round(((nz / length) * 0.5 + 0.5) * 255);
      image.data[pixel + 3] = 255;
    }
  }

  context.putImageData(image, 0, 0);
  texture.update(false);
  texture.wrapU = Texture.WRAP_ADDRESSMODE;
  texture.wrapV = Texture.WRAP_ADDRESSMODE;
  return texture;
};

/**
 * Bright, softly lit ball with a fresnel rim so it separates from both sky
 * and grass. Emissive keeps it readable in shadow and at broadcast distance.
 */
const createBallMaterial = (scene: Scene): StandardMaterial => {
  const material = new StandardMaterial("golf-ball-material", scene);
  material.diffuseColor = toColor3(PALETTE.ball.body);
  material.specularColor = new Color3(BALL_SPECULAR, BALL_SPECULAR, BALL_SPECULAR);
  material.specularPower = BALL_SPECULAR_POWER;
  material.emissiveColor = toColor3(PALETTE.ball.body).scale(BALL_EMISSIVE);
  material.emissiveFresnelParameters = new FresnelParameters({
    leftColor: toColor3(PALETTE.ball.rim),
    rightColor: Color3.Black(),
    power: BALL_RIM_POWER,
  });
  material.bumpTexture = createDimpleNormalTexture(scene);
  material.bumpTexture.level = BALL_DIMPLE_STRENGTH;
  return material;
};

export const createBallRenderer = (
  scene: Scene,
  radiusM: number,
  groundHeightAt: GroundHeightResolver,
): BallRenderer => {
  const mesh = MeshBuilder.CreateSphere(
    "golf-ball",
    {
      diameter: radiusM * 2,
      segments: 28,
    },
    scene,
  );
  mesh.material = createBallMaterial(scene);

  const shadow = MeshBuilder.CreateDisc(
    "ball-shadow",
    {
      radius: radiusM * 1.8,
      tessellation: 40,
    },
    scene,
  );
  shadow.rotation.x = Math.PI / 2;
  shadow.position.y = 0.01;

  const shadowMaterial = new StandardMaterial("ball-shadow-material", scene);
  shadowMaterial.diffuseColor = toColor3(PALETTE.ball.shadow);
  shadowMaterial.specularColor = Color3.Black();
  shadowMaterial.alpha = BALL_SHADOW_ALPHA;
  shadow.material = shadowMaterial;

  return {
    mesh,
    update(frame) {
      const groundY = groundHeightAt(frame.position.x, frame.position.z);
      const heightAboveGround = Math.max(0, frame.position.y - groundY);
      mesh.position.copyFromFloats(frame.position.x, frame.position.y, frame.position.z);

      mesh.rotation.z += 0.028;
      shadow.position.copyFrom(new Vector3(frame.position.x, groundY + 0.01, frame.position.z));
      shadow.scaling.x = 1 + Math.min(heightAboveGround * 0.04, 2.4);
      shadow.scaling.y = shadow.scaling.x;
      shadow.visibility = Math.max(0.28, 1 - Math.min(heightAboveGround / 90, 0.62));
    },
  };
};
