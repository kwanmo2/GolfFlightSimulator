import {
  Camera,
  ColorCurves,
  DefaultRenderingPipeline,
  ImageProcessingConfiguration,
  Scene,
  SSAO2RenderingPipeline,
} from "@babylonjs/core";
import type { GraphicsQuality } from "../types/simulation";

// Khronos PBR Neutral keeps palette hues intact where ACES would shift and
// desaturate them, so the colours on screen match palette.ts.
const TONEMAP_EXPOSURE = 1.05;
const TONEMAP_CONTRAST = 1.08;
const SATURATION_BOOST = 4;
const VIGNETTE_WEIGHT = 0.9;

const MSAA_SAMPLES = 4;

// A faint glow on the brightest highlights only (sun-lit cloud tops, the ball).
const BLOOM_THRESHOLD = 0.92;
const BLOOM_WEIGHT = 0.12;
const BLOOM_KERNEL = 48;
const BLOOM_SCALE = 0.5;

// Ambient occlusion sized for tree bases, bunker lips and grass clumps.
// Distances are in metres; maxZ skips the far hills where AO only adds noise.
const SSAO_PIPELINE_NAME = "soft-flat-ssao";
const SSAO_RATIO = 0.5;
const SSAO_RADIUS_M = 1.6;
const SSAO_STRENGTH = 0.9;
const SSAO_BASE = 0.12;
const SSAO_MAX_Z_M = 260;
const SSAO_SAMPLES = 16;

export interface PostProcessController {
  setQuality(quality: GraphicsQuality): void;
}

const configureImageProcessing = (configuration: ImageProcessingConfiguration): void => {
  configuration.toneMappingEnabled = true;
  configuration.toneMappingType = ImageProcessingConfiguration.TONEMAPPING_KHR_PBR_NEUTRAL;
  configuration.exposure = TONEMAP_EXPOSURE;
  configuration.contrast = TONEMAP_CONTRAST;
  configuration.vignetteEnabled = true;
  configuration.vignetteWeight = VIGNETTE_WEIGHT;
  configuration.vignetteColor.set(0, 0, 0, 0);

  const curves = new ColorCurves();
  curves.globalSaturation = SATURATION_BOOST;
  configuration.colorCurves = curves;
  configuration.colorCurvesEnabled = true;
};

/**
 * Post stack for the soft flat look: MSAA, a restrained bloom, tone mapping
 * that respects the palette, and SSAO for contact shading. The "standard"
 * quality drops SSAO, the one expensive pass.
 */
export const createPostProcessing = (scene: Scene, cameras: Camera[]): PostProcessController => {
  configureImageProcessing(scene.imageProcessingConfiguration);

  const pipeline = new DefaultRenderingPipeline("soft-flat-pipeline", true, scene, cameras);
  pipeline.samples = MSAA_SAMPLES;
  pipeline.fxaaEnabled = false;
  pipeline.bloomEnabled = true;
  pipeline.bloomThreshold = BLOOM_THRESHOLD;
  pipeline.bloomWeight = BLOOM_WEIGHT;
  pipeline.bloomKernel = BLOOM_KERNEL;
  pipeline.bloomScale = BLOOM_SCALE;
  pipeline.imageProcessingEnabled = true;

  const ssao = SSAO2RenderingPipeline.IsSupported
    ? new SSAO2RenderingPipeline(SSAO_PIPELINE_NAME, scene, { ssaoRatio: SSAO_RATIO, blurRatio: 1 }, cameras)
    : null;
  if (ssao) {
    ssao.radius = SSAO_RADIUS_M;
    ssao.totalStrength = SSAO_STRENGTH;
    ssao.base = SSAO_BASE;
    ssao.maxZ = SSAO_MAX_Z_M;
    ssao.samples = SSAO_SAMPLES;
    ssao.expensiveBlur = true;
  }
  // Toggled by attaching and detaching rather than rebuilding: disposing the
  // pipeline also tears down the shared prepass and blanks the frame.
  let ssaoAttached = ssao !== null;
  const manager = scene.postProcessRenderPipelineManager;

  return {
    setQuality(quality) {
      const wantSsao = quality === "high" && ssao !== null;
      if (wantSsao === ssaoAttached) {
        return;
      }
      if (wantSsao) {
        manager.attachCamerasToRenderPipeline(SSAO_PIPELINE_NAME, cameras);
      } else {
        manager.detachCamerasFromRenderPipeline(SSAO_PIPELINE_NAME, cameras);
      }
      ssaoAttached = wantSsao;
    },
  };
};
