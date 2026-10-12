import { RenderTargetTexture, ShadowGenerator } from "@babylonjs/core";
import type { AbstractMesh, DirectionalLight } from "@babylonjs/core";
import type { GraphicsQuality } from "../types/simulation";
import { QUALITY_PRESETS } from "./renderConfig";

const SHADOW_BIAS = 0.0008;
const SHADOW_NORMAL_BIAS = 0.02;
/** Fraction of direct light left inside shadows; sky light fills the rest. */
const SHADOW_DARKNESS = 0.15;

export interface ShadowSystem {
  /** Register a mesh that never moves. The shadow map is redrawn on the next frame. */
  addShadowCaster(mesh: AbstractMesh): void;
  setQuality(quality: GraphicsQuality): void;
}

const createGenerator = (sun: DirectionalLight, quality: GraphicsQuality): ShadowGenerator => {
  const generator = new ShadowGenerator(QUALITY_PRESETS[quality].shadowMapSizePx, sun);
  generator.usePercentageCloserFiltering = true;
  generator.filteringQuality = ShadowGenerator.QUALITY_MEDIUM;
  generator.bias = SHADOW_BIAS;
  generator.normalBias = SHADOW_NORMAL_BIAS;
  generator.setDarkness(SHADOW_DARKNESS);
  // Everything that casts is static and the sun does not move, so the map is
  // drawn once and reused. Re-rendering it every frame (cascades follow the
  // camera) cost ~3 ms on an integrated GPU for no visible change.
  generator.getShadowMap()!.refreshRate = RenderTargetTexture.REFRESHRATE_RENDER_ONCE;
  return generator;
};

/**
 * Static sun shadows from the trees, drawn once into a single map that the
 * light fits around all casters. The ball is not a caster (its shadow map
 * would freeze at the tee); ballRenderer.ts draws its own contact shadow.
 *
 * Casters are remembered so a generator rebuilt for a new quality preset picks
 * them all up again; receivers keep their own receiveShadows flag.
 */
export const createShadowSystem = (
  sun: DirectionalLight,
  initialQuality: GraphicsQuality,
): ShadowSystem => {
  const casters: AbstractMesh[] = [];
  let quality = initialQuality;
  let generator = createGenerator(sun, quality);

  return {
    addShadowCaster(mesh) {
      casters.push(mesh);
      generator.addShadowCaster(mesh, false);
      generator.getShadowMap()!.resetRefreshCounter();
    },
    setQuality(nextQuality) {
      if (nextQuality === quality) {
        return;
      }
      quality = nextQuality;
      generator.dispose();
      generator = createGenerator(sun, quality);
      casters.forEach((mesh) => generator.addShadowCaster(mesh, false));
    },
  };
};
