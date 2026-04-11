import {
  Color3,
  DynamicTexture,
  Scene,
  StandardMaterial,
  Texture,
} from "@babylonjs/core";
import type { FieldModel, SurfaceWeights } from "./terrain";

export interface FieldMaterials {
  terrain: StandardMaterial;
  greenPatch: StandardMaterial;
  bunkerPatch: StandardMaterial;
  teePatch: StandardMaterial;
  sky: StandardMaterial;
  flag: StandardMaterial;
  pole: StandardMaterial;
  cup: StandardMaterial;
  treeTrunk: StandardMaterial;
  treeLeafNear: StandardMaterial;
  treeLeafMid: StandardMaterial;
  treeLeafFar: StandardMaterial;
  grassCard: StandardMaterial;
}

interface RgbColor {
  r: number;
  g: number;
  b: number;
}

const clamp01 = (value: number): number => Math.max(0, Math.min(1, value));

const hash2 = (x: number, z: number): number => {
  const value = Math.sin(x * 127.1 + z * 311.7) * 43758.5453123;
  return value - Math.floor(value);
};

const tint = (color: RgbColor, amount: number): RgbColor => ({
  r: color.r + amount,
  g: color.g + amount,
  b: color.b + amount,
});

const mixColor = (a: RgbColor, b: RgbColor, alpha: number): RgbColor => ({
  r: a.r + (b.r - a.r) * alpha,
  g: a.g + (b.g - a.g) * alpha,
  b: a.b + (b.b - a.b) * alpha,
});

const createDynamicTexture = (
  scene: Scene,
  name: string,
  width: number,
  height: number,
  painter: (
    context: CanvasRenderingContext2D,
    width: number,
    height: number,
  ) => void,
): DynamicTexture => {
  const texture = new DynamicTexture(name, { width, height }, scene, false);
  const context = texture.getContext() as unknown as CanvasRenderingContext2D;
  painter(context, width, height);
  texture.update(false);
  texture.wrapU = Texture.CLAMP_ADDRESSMODE;
  texture.wrapV = Texture.CLAMP_ADDRESSMODE;
  return texture;
};

const normalizeWeights = (weights: SurfaceWeights): SurfaceWeights => {
  const total = Math.max(
    0.0001,
    weights.tee +
      weights.fairway +
      weights.rough +
      weights.green +
      weights.bunker +
      weights.fringe,
  );

  return {
    tee: weights.tee / total,
    fairway: weights.fairway / total,
    rough: weights.rough / total,
    green: weights.green / total,
    bunker: weights.bunker / total,
    fringe: weights.fringe / total,
  };
};

const sampleTerrainColor = (field: FieldModel, x: number, z: number): RgbColor => {
  const weights = normalizeWeights(field.getSurfaceWeights(x, z));
  const stripe = Math.floor((z + 18) / 18) % 2 === 0 ? 1 : -1;
  const corridorStripe = stripe * weights.fairway * 11;
  const largeNoise =
    Math.sin(x * 0.05 + z * 0.006) * 4 +
    Math.cos(z * 0.031 - x * 0.014) * 3 +
    (hash2(Math.floor(x * 0.5), Math.floor(z * 0.5)) - 0.5) * 8;
  const microNoise = (hash2(Math.floor(x * 2), Math.floor(z * 2)) - 0.5) * 6;

  const roughBase: RgbColor = { r: 78, g: 111, b: 49 };
  const fairwayBase: RgbColor = { r: 112, g: 149, b: 70 };
  const teeBase: RgbColor = { r: 103, g: 142, b: 69 };
  const greenBase: RgbColor = { r: 95, g: 136, b: 64 };
  const fringeBase: RgbColor = { r: 102, g: 144, b: 63 };
  const bunkerBase: RgbColor = { r: 205, g: 188, b: 146 };

  let color: RgbColor = { r: 0, g: 0, b: 0 };
  const sources: Array<[RgbColor, number]> = [
    [tint(teeBase, largeNoise * 0.55), weights.tee],
    [tint(fairwayBase, corridorStripe + largeNoise * 0.4), weights.fairway],
    [tint(roughBase, largeNoise * 0.45), weights.rough],
    [tint(greenBase, Math.sin(z * 0.18) * 2 + microNoise * 0.6), weights.green],
    [tint(fringeBase, largeNoise * 0.38), weights.fringe],
    [tint(bunkerBase, Math.sin((x + z) * 0.14) * 2 + microNoise * 0.35), weights.bunker],
  ];

  for (const [source, weight] of sources) {
    color = {
      r: color.r + source.r * weight,
      g: color.g + source.g * weight,
      b: color.b + source.b * weight,
    };
  }

  const sunWash = clamp01((field.holeLengthM - Math.abs(z - field.green.centerZ)) / field.holeLengthM);
  return mixColor(color, { r: 198, g: 205, b: 165 }, sunWash * weights.bunker * 0.08);
};

const createTerrainColorTexture = (scene: Scene, field: FieldModel): DynamicTexture =>
  createDynamicTexture(scene, "terrain-color-map", 1024, 2048, (context, width, height) => {
    const image = context.createImageData(width, height);

    for (let py = 0; py < height; py += 1) {
      for (let px = 0; px < width; px += 1) {
        const x = (px / (width - 1) - 0.5) * field.terrainWidthM;
        const z = (py / (height - 1) - 0.5) * field.terrainLengthM;
        const color = sampleTerrainColor(field, x, z);
        const index = (py * width + px) * 4;
        image.data[index] = Math.max(0, Math.min(255, Math.round(color.r)));
        image.data[index + 1] = Math.max(0, Math.min(255, Math.round(color.g)));
        image.data[index + 2] = Math.max(0, Math.min(255, Math.round(color.b)));
        image.data[index + 3] = 255;
      }
    }

    context.putImageData(image, 0, 0);
  });

const createTerrainDetailTexture = (scene: Scene): DynamicTexture =>
  createDynamicTexture(scene, "terrain-detail-map", 256, 256, (context, width, height) => {
    context.fillStyle = "#808080";
    context.fillRect(0, 0, width, height);

    for (let i = 0; i < 1400; i += 1) {
      const x = hash2(i, 1.3) * width;
      const y = hash2(i, 3.7) * height;
      const length = 8 + hash2(i, 7.1) * 20;
      const alpha = 0.04 + hash2(i, 11.9) * 0.08;

      context.strokeStyle = `rgba(255,255,255,${alpha.toFixed(3)})`;
      context.beginPath();
      context.moveTo(x, y);
      context.lineTo(x + (hash2(i, 4.2) - 0.5) * 4, y + length);
      context.stroke();
    }

    for (let i = 0; i < 1200; i += 1) {
      const x = hash2(i, 15.4) * width;
      const y = hash2(i, 19.2) * height;
      const radius = 0.6 + hash2(i, 21.8) * 1.6;
      context.fillStyle = `rgba(0,0,0,${(0.035 + hash2(i, 13.4) * 0.05).toFixed(3)})`;
      context.beginPath();
      context.arc(x, y, radius, 0, Math.PI * 2);
      context.fill();
    }
  });

const createRadialPatchTexture = (
  scene: Scene,
  name: string,
  innerColor: string,
  edgeColor: string,
  fadeFrom = 0.7,
): DynamicTexture =>
  createDynamicTexture(scene, name, 512, 512, (context, width, height) => {
    const gradient = context.createRadialGradient(
      width / 2,
      height / 2,
      width * 0.08,
      width / 2,
      height / 2,
      width * 0.48,
    );
    gradient.addColorStop(0, innerColor);
    gradient.addColorStop(fadeFrom, innerColor);
    gradient.addColorStop(1, edgeColor);
    context.fillStyle = gradient;
    context.fillRect(0, 0, width, height);
  });

const createSkyTexture = (scene: Scene): DynamicTexture =>
  createDynamicTexture(scene, "field-sky", 128, 1024, (context, width, height) => {
    const gradient = context.createLinearGradient(0, 0, 0, height);
    gradient.addColorStop(0, "#4b81d0");
    gradient.addColorStop(0.38, "#92c2f1");
    gradient.addColorStop(0.72, "#d9ecfb");
    gradient.addColorStop(1, "#f6fbff");
    context.fillStyle = gradient;
    context.fillRect(0, 0, width, height);
  });

const createGrassCardTexture = (scene: Scene): DynamicTexture =>
  createDynamicTexture(scene, "grass-card", 128, 256, (context, width, height) => {
    context.clearRect(0, 0, width, height);
    for (let i = 0; i < 22; i += 1) {
      const x = width * (0.1 + hash2(i, 2.4) * 0.8);
      const baseY = height - 4;
      const topY = 28 + hash2(i, 5.1) * 44;
      const bend = (hash2(i, 9.2) - 0.5) * 24;
      context.strokeStyle = `rgba(${80 + Math.round(hash2(i, 1.7) * 34)}, ${130 + Math.round(hash2(i, 3.4) * 40)}, ${58 + Math.round(hash2(i, 4.6) * 20)}, 0.9)`;
      context.lineWidth = 2 + hash2(i, 7.4) * 1.6;
      context.beginPath();
      context.moveTo(x, baseY);
      context.quadraticCurveTo(x + bend * 0.4, (baseY + topY) * 0.58, x + bend, topY);
      context.stroke();
    }
  });

export const createFieldMaterials = (scene: Scene, field: FieldModel): FieldMaterials => {
  const terrain = new StandardMaterial("terrain-material", scene);
  terrain.diffuseTexture = createTerrainColorTexture(scene, field);
  terrain.bumpTexture = createTerrainDetailTexture(scene);
  terrain.specularColor = Color3.Black();
  (terrain.bumpTexture as Texture).uScale = 18;
  (terrain.bumpTexture as Texture).vScale = 24;
  terrain.bumpTexture.level = 0.12;

  const greenPatch = new StandardMaterial("green-patch-material", scene);
  greenPatch.diffuseTexture = createRadialPatchTexture(
    scene,
    "green-patch",
    "rgba(91, 133, 56, 0.92)",
    "rgba(91, 133, 56, 0)",
    0.68,
  );
  greenPatch.specularColor = Color3.Black();
  greenPatch.alpha = 0.95;

  const bunkerPatch = new StandardMaterial("bunker-patch-material", scene);
  bunkerPatch.diffuseTexture = createRadialPatchTexture(
    scene,
    "bunker-patch",
    "rgba(212, 194, 155, 0.96)",
    "rgba(212, 194, 155, 0)",
    0.62,
  );
  bunkerPatch.specularColor = new Color3(0.04, 0.04, 0.04);
  bunkerPatch.alpha = 0.92;

  const teePatch = new StandardMaterial("tee-patch-material", scene);
  teePatch.diffuseTexture = createRadialPatchTexture(
    scene,
    "tee-patch",
    "rgba(109, 146, 72, 0.9)",
    "rgba(109, 146, 72, 0)",
    0.76,
  );
  teePatch.specularColor = Color3.Black();
  teePatch.alpha = 0.9;

  const sky = new StandardMaterial("sky-material", scene);
  sky.diffuseTexture = createSkyTexture(scene);
  sky.emissiveColor = new Color3(0.67, 0.79, 0.96);
  sky.specularColor = Color3.Black();

  const flag = new StandardMaterial("flag-material", scene);
  flag.diffuseColor = new Color3(0.94, 0.35, 0.22);
  flag.emissiveColor = new Color3(0.12, 0.03, 0.02);
  flag.specularColor = new Color3(0.18, 0.18, 0.18);

  const pole = new StandardMaterial("flag-pole-material", scene);
  pole.diffuseColor = new Color3(0.86, 0.87, 0.85);
  pole.specularColor = new Color3(0.2, 0.2, 0.2);

  const cup = new StandardMaterial("cup-material", scene);
  cup.diffuseColor = new Color3(0.09, 0.12, 0.08);
  cup.specularColor = Color3.Black();

  const treeTrunk = new StandardMaterial("tree-trunk-material", scene);
  treeTrunk.diffuseColor = new Color3(0.35, 0.24, 0.15);
  treeTrunk.specularColor = Color3.Black();

  const treeLeafNear = new StandardMaterial("tree-leaf-near-material", scene);
  treeLeafNear.diffuseColor = new Color3(0.28, 0.43, 0.22);
  treeLeafNear.specularColor = Color3.Black();

  const treeLeafMid = new StandardMaterial("tree-leaf-mid-material", scene);
  treeLeafMid.diffuseColor = new Color3(0.3, 0.4, 0.23);
  treeLeafMid.specularColor = Color3.Black();

  const treeLeafFar = new StandardMaterial("tree-leaf-far-material", scene);
  treeLeafFar.diffuseColor = new Color3(0.34, 0.39, 0.29);
  treeLeafFar.specularColor = Color3.Black();

  const grassCard = new StandardMaterial("grass-card-material", scene);
  grassCard.diffuseTexture = createGrassCardTexture(scene);
  grassCard.diffuseTexture.hasAlpha = true;
  grassCard.useAlphaFromDiffuseTexture = true;
  grassCard.backFaceCulling = false;
  grassCard.specularColor = Color3.Black();

  return {
    terrain,
    greenPatch,
    bunkerPatch,
    teePatch,
    sky,
    flag,
    pole,
    cup,
    treeTrunk,
    treeLeafNear,
    treeLeafMid,
    treeLeafFar,
    grassCard,
  };
};
