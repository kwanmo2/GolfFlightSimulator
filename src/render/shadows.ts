import { CascadedShadowGenerator, ShadowGenerator } from "@babylonjs/core";
import type { AbstractMesh, DirectionalLight } from "@babylonjs/core";
import type { GraphicsQuality } from "../types/simulation";
import { QUALITY_PRESETS } from "./renderConfig";

const SHADOW_BIAS = 0.0008;
const SHADOW_NORMAL_BIAS = 0.02;
/** Fraction of direct light left inside shadows; sky light fills the rest. */
const SHADOW_DARKNESS = 0.15;

// Cascades cover the hole out past the green; beyond that the trees are far
// enough away that missing shadows go unnoticed.
const CASCADE_MAX_Z_M = 420;
/** Blend toward logarithmic splits: more resolution near the camera. */
const CASCADE_LAMBDA = 0.85;
const CASCADE_BLEND = 0.08;

export interface ShadowSystem {
  addShadowCaster(mesh: AbstractMesh): void;
  setQuality(quality: GraphicsQuality): void;
}

const createGenerator = (sun: DirectionalLight, quality: GraphicsQuality): ShadowGenerator => {
  const preset = QUALITY_PRESETS[quality];
  let generator: ShadowGenerator;
  if (preset.cascadedShadows && CascadedShadowGenerator.IsSupported) {
    const cascaded = new CascadedShadowGenerator(preset.shadowMapSizePx, sun);
    cascaded.numCascades = preset.shadowCascades;
    cascaded.shadowMaxZ = CASCADE_MAX_Z_M;
    cascaded.lambda = CASCADE_LAMBDA;
    cascaded.cascadeBlendPercentage = CASCADE_BLEND;
    cascaded.stabilizeCascades = true;
    cascaded.depthClamp = true;
    generator = cascaded;
  } else {
    generator = new ShadowGenerator(preset.shadowMapSizePx, sun);
  }
  generator.usePercentageCloserFiltering = true;
  generator.filteringQuality = ShadowGenerator.QUALITY_MEDIUM;
  generator.bias = SHADOW_BIAS;
  generator.normalBias = SHADOW_NORMAL_BIAS;
  generator.setDarkness(SHADOW_DARKNESS);
  return generator;
};

/**
 * Sun shadows that can be rebuilt for a new quality preset. Casters are
 * remembered so a rebuilt generator picks them all up again; receivers keep
 * their own receiveShadows flag and need nothing.
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
