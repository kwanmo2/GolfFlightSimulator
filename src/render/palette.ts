import { Color3, Color4 } from "@babylonjs/core";

/**
 * Painted colours for course surfaces, vegetation, props and overlays. Sky,
 * light and tone settings live in renderConfig.ts.
 *
 * Values are sRGB hex strings. Use toLinearColor3 for physically based
 * materials and toColor3 / toColor4 for unlit overlays; each returns a fresh
 * Babylon colour, since Babylon colours are mutable.
 */
export const PALETTE = {
  surface: {
    rough: "#588d3b",
    firstCut: "#659d40",
    fairway: "#77b349",
    fringe: "#72ad47",
    green: "#84c458",
    sand: "#efdaa2",
    backdrop: "#4f7d52",
    water: "#2e74b5",
    cartPath: "#aea283",
  },
  vegetation: {
    leafLight: "#6fae45",
    leafMid: "#4f913a",
    leafDark: "#3d7a35",
    conifer: "#2f6a3d",
    trunk: "#7a5236",
    bush: "#5c9a3f",
    grass: "#6b9f42",
    flowerYellow: "#f4cf45",
    flowerWhite: "#f6f2e6",
  },
  props: {
    flag: "#e8412c",
    flagText: "#fffaf0",
    pole: "#f4f2ea",
    cupHole: "#1c2616",
    cupRim: "#f4f2ea",
    teeMarker: "#f4f2ea",
    markerPost: "#f4f2ea",
    markerLabel: "#20361c",
    marker100: "#e0503f",
    marker150: "#f4f2ea",
    marker200: "#3f7fd9",
  },
  ball: {
    body: "#ffffff",
    shadow: "#274a1c",
  },
  trajectory: {
    current: "#ffd65a",
    currentShadow: "#3f6b2f",
    comparison: "#6cc4ff",
    landing: "#ffad4d",
    comparisonLanding: "#7dc2ff",
    liveMarker: "#fff5dc",
  },
} as const;

export const toColor3 = (hex: string): Color3 => Color3.FromHexString(hex);

/** Linear colour for physically based materials, which do their lighting in linear space. */
export const toLinearColor3 = (hex: string): Color3 => Color3.FromHexString(hex).toLinearSpace();

export const toColor4 = (hex: string, alpha = 1): Color4 => {
  const color = Color3.FromHexString(hex);
  return new Color4(color.r, color.g, color.b, alpha);
};
