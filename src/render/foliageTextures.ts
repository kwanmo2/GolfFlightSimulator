import { Constants, RawTexture, Texture } from "@babylonjs/core";
import type { Scene } from "@babylonjs/core";
import { mulberry32 } from "./proceduralNoise";

/**
 * Foliage card textures, composed at load time from the cut-out ambientCG
 * atlases in public/textures/vegetation (see scripts/fetch-assets.py). An
 * atlas holds single leaves, sprays or blades; drawing dozens of them onto one
 * card gives a leaf cluster or grass clump that a tree can use a few hundred
 * times, which is how real-time foliage stays both photographic and cheap.
 */

const VEGETATION_ROOT = "/textures/vegetation/";
const CARD_SIZE_PX = 1024;
/** Pixels at least this opaque count toward the card's mean colour. */
const MEAN_COLOUR_ALPHA = 128;

export type FoliageAtlasName = "beech" | "oak" | "linden" | "fir" | "grass" | "weeds";

interface AtlasManifestEntry {
  size: number;
  /** [x, y, width, height] in atlas pixels. */
  sprites: Array<[number, number, number, number]>;
}

export interface FoliageAtlas {
  image: ImageBitmap;
  sprites: Array<[number, number, number, number]>;
}

export interface FoliageCard {
  texture: Texture;
  /** Mean linear-ish colour of the opaque pixels, for bake backgrounds. */
  meanColor: [number, number, number];
}

let manifestPromise: Promise<Record<string, AtlasManifestEntry>> | null = null;

const loadManifest = (): Promise<Record<string, AtlasManifestEntry>> => {
  manifestPromise ??= fetch(`${VEGETATION_ROOT}atlases.json`).then((response) => {
    if (!response.ok) {
      throw new Error(`Failed to load the foliage atlas manifest: ${response.status}`);
    }
    return response.json() as Promise<Record<string, AtlasManifestEntry>>;
  });
  return manifestPromise;
};

export const loadFoliageAtlas = async (name: FoliageAtlasName): Promise<FoliageAtlas> => {
  const [manifest, response] = await Promise.all([loadManifest(), fetch(`${VEGETATION_ROOT}${name}.webp`)]);
  if (!response.ok) {
    throw new Error(`Failed to load the ${name} foliage atlas: ${response.status}`);
  }
  const entry = manifest[name];
  if (!entry || entry.sprites.length === 0) {
    throw new Error(`The foliage manifest has no sprites for ${name}.`);
  }
  const image = await createImageBitmap(await response.blob(), {
    colorSpaceConversion: "none",
    premultiplyAlpha: "none",
  });
  return { image, sprites: entry.sprites };
};

type Context = OffscreenCanvasRenderingContext2D;
type Random = () => number;

const createCanvas = (): { canvas: OffscreenCanvas; context: Context } => {
  const canvas = new OffscreenCanvas(CARD_SIZE_PX, CARD_SIZE_PX);
  const context = canvas.getContext("2d");
  if (!context) {
    throw new Error("2D canvas unavailable for composing foliage cards.");
  }
  return { canvas, context };
};

/**
 * Draw one sprite with its stem at (x, y), pointing along `angle` (radians,
 * 0 = up the card). `stemAtBottom` says where the stem sits in the atlas:
 * leaves and blades stand upright, fir sprays lie with the stem on the right.
 */
const drawSprite = (
  context: Context,
  atlas: FoliageAtlas,
  sprite: [number, number, number, number],
  x: number,
  y: number,
  angle: number,
  lengthPx: number,
  stemAtBottom: boolean,
  shade: number,
  mirror: boolean,
): void => {
  const [sx, sy, sw, sh] = sprite;
  const spriteLength = stemAtBottom ? sh : sw;
  const scale = lengthPx / spriteLength;
  context.save();
  context.translate(x, y);
  context.rotate(angle);
  if (mirror) {
    context.scale(-1, 1);
  }
  // Brightness jitter where the canvas supports filters; harmless otherwise.
  context.filter = `brightness(${shade.toFixed(3)})`;
  if (stemAtBottom) {
    context.drawImage(atlas.image, sx, sy, sw, sh, (-sw * scale) / 2, -sh * scale, sw * scale, sh * scale);
  } else {
    // Stem on the right of the sprite: rotate so the spray points up the card.
    context.rotate(Math.PI / 2);
    context.drawImage(atlas.image, sx, sy, sw, sh, -sw * scale, (-sh * scale) / 2, sw * scale, sh * scale);
  }
  context.restore();
};

/** A slightly curved twig, drawn before the leaves so they hide most of it. */
const drawTwig = (context: Context, from: [number, number], to: [number, number], widthPx: number, random: Random): void => {
  const bend = (random() - 0.5) * 0.25;
  const midX = (from[0] + to[0]) / 2 + (to[1] - from[1]) * bend;
  const midY = (from[1] + to[1]) / 2 - (to[0] - from[0]) * bend;
  context.strokeStyle = "rgb(74, 58, 42)";
  context.lineWidth = widthPx;
  context.lineCap = "round";
  context.beginPath();
  context.moveTo(from[0], from[1]);
  context.quadraticCurveTo(midX, midY, to[0], to[1]);
  context.stroke();
};

/**
 * Turn the canvas into a mipmapped texture. Fully transparent pixels take the
 * card's mean colour, so filtering and mipmaps blend toward foliage instead of
 * the black a canvas stores there (the dark halo of naive alpha cards).
 */
const finishCard = (scene: Scene, name: string, context: Context): FoliageCard => {
  const image = context.getImageData(0, 0, CARD_SIZE_PX, CARD_SIZE_PX);
  const data = image.data;
  let r = 0;
  let g = 0;
  let b = 0;
  let count = 0;
  for (let index = 0; index < data.length; index += 4) {
    if (data[index + 3] >= MEAN_COLOUR_ALPHA) {
      r += data[index];
      g += data[index + 1];
      b += data[index + 2];
      count += 1;
    }
  }
  const mean: [number, number, number] = count > 0 ? [r / count, g / count, b / count] : [80, 100, 50];
  for (let index = 0; index < data.length; index += 4) {
    if (data[index + 3] === 0) {
      data[index] = mean[0];
      data[index + 1] = mean[1];
      data[index + 2] = mean[2];
    }
  }
  // Canvas rows run top-down; texture row 0 is v = 0, the bottom of a quad.
  // Flip so the card's "up" is +v.
  const flipped = new Uint8Array(data.length);
  const rowBytes = CARD_SIZE_PX * 4;
  for (let row = 0; row < CARD_SIZE_PX; row += 1) {
    flipped.set(data.subarray(row * rowBytes, (row + 1) * rowBytes), (CARD_SIZE_PX - 1 - row) * rowBytes);
  }
  const texture = RawTexture.CreateRGBATexture(
    flipped,
    CARD_SIZE_PX,
    CARD_SIZE_PX,
    scene,
    true,
    false,
    Constants.TEXTURE_TRILINEAR_SAMPLINGMODE,
  );
  texture.name = name;
  texture.hasAlpha = true;
  texture.wrapU = Texture.CLAMP_ADDRESSMODE;
  texture.wrapV = Texture.CLAMP_ADDRESSMODE;
  texture.anisotropicFilteringLevel = 4;
  return { texture, meanColor: [mean[0] / 255, mean[1] / 255, mean[2] / 255] };
};

/**
 * A broadleaf cluster: a few twigs fanning up from the bottom centre of the
 * card, each carrying leaves, plus loose leaves filling the gaps.
 */
export const composeLeafCluster = (scene: Scene, name: string, atlas: FoliageAtlas, seed: number): FoliageCard => {
  const random = mulberry32(seed);
  const { context } = createCanvas();
  const size = CARD_SIZE_PX;
  const base: [number, number] = [size * 0.5, size * 0.98];
  const twigCount = 5;
  const leafLength = size * 0.2;
  const tips: Array<[number, number]> = [];
  for (let twig = 0; twig < twigCount; twig += 1) {
    const angle = (twig / (twigCount - 1) - 0.5) * 1.9 + (random() - 0.5) * 0.25;
    const length = size * (0.55 + random() * 0.3);
    const tip: [number, number] = [base[0] + Math.sin(angle) * length, base[1] - Math.cos(angle) * length];
    tips.push(tip);
    drawTwig(context, base, tip, size * 0.008, random);
  }
  const drawLeaf = (x: number, y: number, angle: number): void => {
    const sprite = atlas.sprites[Math.floor(random() * atlas.sprites.length)];
    drawSprite(context, atlas, sprite, x, y, angle, leafLength * (0.75 + random() * 0.45), true, 0.78 + random() * 0.4, random() < 0.5);
  };
  tips.forEach((tip) => {
    const twigAngle = Math.atan2(tip[0] - base[0], base[1] - tip[1]);
    for (let leaf = 0; leaf < 9; leaf += 1) {
      const t = 0.3 + (leaf / 8) * 0.7;
      const x = base[0] + (tip[0] - base[0]) * t;
      const y = base[1] + (tip[1] - base[1]) * t;
      const side = leaf % 2 === 0 ? -1 : 1;
      drawLeaf(x, y, twigAngle + side * (0.5 + random() * 0.5));
    }
    drawLeaf(tip[0], tip[1], twigAngle + (random() - 0.5) * 0.3);
  });
  for (let leaf = 0; leaf < 22; leaf += 1) {
    const angle = (random() - 0.5) * 2.4;
    const distance = size * (0.2 + random() * 0.45);
    drawLeaf(base[0] + Math.sin(angle) * distance, base[1] - Math.cos(angle) * distance, angle + (random() - 0.5));
  }
  return finishCard(scene, name, context);
};

/** A conifer branch end: overlapping sprays fanning up from the bottom centre. */
export const composeNeedleCluster = (scene: Scene, name: string, atlas: FoliageAtlas, seed: number): FoliageCard => {
  const random = mulberry32(seed);
  const { context } = createCanvas();
  const size = CARD_SIZE_PX;
  const sprays = 7;
  for (let spray = 0; spray < sprays; spray += 1) {
    const angle = (spray / (sprays - 1) - 0.5) * 1.1 + (random() - 0.5) * 0.15;
    const sprite = atlas.sprites[Math.floor(random() * atlas.sprites.length)];
    const length = size * (spray === Math.floor(sprays / 2) ? 0.95 : 0.6 + random() * 0.25);
    drawSprite(context, atlas, sprite, size * 0.5, size * 0.99, angle, length, false, 0.8 + random() * 0.35, random() < 0.5);
  }
  return finishCard(scene, name, context);
};

/** A grass clump: blades rooted along the bottom of the card, fanning outwards, with a few weeds. */
export const composeGrassClump = (
  scene: Scene,
  name: string,
  grass: FoliageAtlas,
  weeds: FoliageAtlas,
  seed: number,
): FoliageCard => {
  const random = mulberry32(seed);
  const { context } = createCanvas();
  const size = CARD_SIZE_PX;
  const draw = (atlas: FoliageAtlas, count: number, minLength: number, maxLength: number, spread: number): void => {
    for (let blade = 0; blade < count; blade += 1) {
      const x = size * (0.5 + (random() - 0.5) * spread);
      const lean = ((x / size - 0.5) / spread) * 0.7 + (random() - 0.5) * 0.35;
      const sprite = atlas.sprites[Math.floor(random() * atlas.sprites.length)];
      const length = size * (minLength + random() * (maxLength - minLength));
      drawSprite(context, atlas, sprite, x, size * 0.995, lean, length, true, 0.75 + random() * 0.45, random() < 0.5);
    }
  };
  draw(grass, 30, 0.5, 0.95, 0.55);
  draw(weeds, 8, 0.45, 0.85, 0.7);
  return finishCard(scene, name, context);
};

/** Bark colour and normal maps for one tree family. */
export const loadBarkTextures = (scene: Scene, family: "broadleaf" | "conifer"): { color: Texture; normal: Texture } => {
  const color = new Texture(`${VEGETATION_ROOT}bark_${family}_color.jpg`, scene);
  const normal = new Texture(`${VEGETATION_ROOT}bark_${family}_normal.jpg`, scene);
  normal.gammaSpace = false;
  return { color, normal };
};
