import { Color3, Color4 } from "@babylonjs/core";

/**
 * Single source of truth for the scene's colours. The look is "soft flat":
 * every surface is a flat palette colour, shaped only by lighting, soft
 * shadows and ambient occlusion, so the course reads as one consistent style.
 *
 * Values are sRGB hex strings. Use toColor3 / toColor4 to get a fresh Babylon
 * colour; Babylon colours are mutable, so shared instances are never exported.
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
  sky: {
    zenith: "#4b97e6",
    mid: "#7fbaf0",
    horizon: "#d6eaf6",
    belowHorizon: "#cfe2d6",
    cloud: "#ffffff",
    cloudShade: "#dde8f2",
  },
  light: {
    sun: "#fff3dc",
    sky: "#d4e6ff",
    groundBounce: "#7d8f52",
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
    rim: "#e8f4ff",
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

export const toColor4 = (hex: string, alpha = 1): Color4 => {
  const color = Color3.FromHexString(hex);
  return new Color4(color.r, color.g, color.b, alpha);
};
