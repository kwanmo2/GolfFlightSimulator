import { Constants, RawTexture2DArray } from "@babylonjs/core";
import type { Scene } from "@babylonjs/core";

/**
 * Texture layers of the terrain arrays, in layer order. Files come from
 * scripts/fetch-assets.py: `<layer>_detail.jpg` is a linear detail map with a
 * mean of 0.5, `<layer>_normal.jpg` an OpenGL-convention normal map.
 */
export const TERRAIN_LAYERS = ["rough", "fairway", "green", "sand"] as const;
export type TerrainLayer = (typeof TERRAIN_LAYERS)[number];

const TEXTURE_ROOT = "/textures/terrain/";
const TEXTURE_SIZE_PX = 1024;
const ANISOTROPY = 8;
const GENERATE_MIPMAPS = true;
const INVERT_Y = false;

export interface TerrainTextureArrays {
  detail: RawTexture2DArray;
  normal: RawTexture2DArray;
}

/** Decode one image to raw RGBA bytes, exactly as stored (no colour management). */
const loadPixels = async (url: string): Promise<Uint8ClampedArray> => {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Failed to load ${url}: ${response.status}`);
  }
  const bitmap = await createImageBitmap(await response.blob(), {
    colorSpaceConversion: "none",
    premultiplyAlpha: "none",
  });
  if (bitmap.width !== TEXTURE_SIZE_PX || bitmap.height !== TEXTURE_SIZE_PX) {
    throw new Error(`${url} is ${bitmap.width}x${bitmap.height}, expected ${TEXTURE_SIZE_PX}px square.`);
  }
  const canvas = new OffscreenCanvas(TEXTURE_SIZE_PX, TEXTURE_SIZE_PX);
  const context = canvas.getContext("2d");
  if (!context) {
    throw new Error("2D canvas unavailable for decoding terrain textures.");
  }
  context.drawImage(bitmap, 0, 0);
  bitmap.close();
  return context.getImageData(0, 0, TEXTURE_SIZE_PX, TEXTURE_SIZE_PX).data;
};

const createArray = async (scene: Scene, suffix: string): Promise<RawTexture2DArray> => {
  const layers = await Promise.all(
    TERRAIN_LAYERS.map((layer) => loadPixels(`${TEXTURE_ROOT}${layer}_${suffix}.jpg`)),
  );
  const layerBytes = TEXTURE_SIZE_PX * TEXTURE_SIZE_PX * 4;
  const data = new Uint8Array(layerBytes * layers.length);
  layers.forEach((pixels, index) => data.set(pixels, index * layerBytes));

  const texture = new RawTexture2DArray(
    data,
    TEXTURE_SIZE_PX,
    TEXTURE_SIZE_PX,
    layers.length,
    Constants.TEXTUREFORMAT_RGBA,
    scene,
    GENERATE_MIPMAPS,
    INVERT_Y,
    Constants.TEXTURE_TRILINEAR_SAMPLINGMODE,
  );
  texture.name = `terrain-${suffix}-array`;
  texture.wrapU = Constants.TEXTURE_WRAP_ADDRESSMODE;
  texture.wrapV = Constants.TEXTURE_WRAP_ADDRESSMODE;
  texture.anisotropicFilteringLevel = ANISOTROPY;
  // Both arrays hold data, not sRGB colour.
  texture.gammaSpace = false;
  return texture;
};

/** Load the terrain detail and normal maps as two 2D texture arrays (WebGL2). */
export const loadTerrainTextureArrays = async (scene: Scene): Promise<TerrainTextureArrays> => {
  const [detail, normal] = await Promise.all([createArray(scene, "detail"), createArray(scene, "normal")]);
  return { detail, normal };
};
