import {
  Camera,
  ColorCurves,
  DefaultRenderingPipeline,
  ImageProcessingConfiguration,
  Scene,
  SSAO2RenderingPipeline,
} from "@babylonjs/core";
import type { GraphicsQuality } from "../types/simulation";
import { DEFAULT_GRAPHICS_QUALITY, QUALITY_PRESETS, TONE } from "./renderConfig";

const MSAA_SAMPLES = 4;

// The pipeline renders in HDR, so bloom only picks up what is far brighter
// than sunlit grass or sand: the sun disc, its glare on the water, the ball.
const BLOOM_THRESHOLD = 2.5;
const BLOOM_WEIGHT = 0.15;
const BLOOM_KERNEL = 48;
const BLOOM_SCALE = 0.5;

// Ambient occlusion sized for tree bases, bunker lips and grass clumps.
// Distances are in metres; maxZ skips the far hills where AO only adds noise.
const SSAO_PIPELINE_NAME = "scene-ssao";
const SSAO_RATIO = 0.5;
const SSAO_RADIUS_M = 1.6;
const SSAO_STRENGTH = 0.9;
const SSAO_BASE = 0.12;
const SSAO_MAX_Z_M = 260;
const SSAO_SAMPLES = 16;

export interface PostProcessController {
  setQuality(quality: GraphicsQuality): void;
}

// ACES rolls off bright sky and sunlit surfaces the way film does, which is
// most of what reads as "photographic" rather than "painted".
const configureImageProcessing = (configuration: ImageProcessingConfiguration): void => {
  configuration.toneMappingEnabled = true;
  configuration.toneMappingType = ImageProcessingConfiguration.TONEMAPPING_ACES;
  configuration.exposure = TONE.exposure;
  configuration.contrast = TONE.contrast;
  configuration.vignetteEnabled = true;
  configuration.vignetteWeight = TONE.vignetteWeight;
  configuration.vignetteColor.set(0, 0, 0, 0);

  const curves = new ColorCurves();
  curves.globalSaturation = TONE.saturation;
  configuration.colorCurves = curves;
  configuration.colorCurvesEnabled = true;
};

/**
 * HDR post stack: MSAA, a restrained bloom, ACES tone mapping, and SSAO for
 * contact shading where the quality preset allows it.
 */
export const createPostProcessing = (scene: Scene, cameras: Camera[]): PostProcessController => {
  configureImageProcessing(scene.imageProcessingConfiguration);

  const pipeline = new DefaultRenderingPipeline("scene-pipeline", true, scene, cameras);
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
  if (ssao && !QUALITY_PRESETS[DEFAULT_GRAPHICS_QUALITY].ssao) {
    scene.postProcessRenderPipelineManager.detachCamerasFromRenderPipeline(SSAO_PIPELINE_NAME, cameras);
    ssaoAttached = false;
  }
  const manager = scene.postProcessRenderPipelineManager;

  return {
    setQuality(quality) {
      const wantSsao = QUALITY_PRESETS[quality].ssao && ssao !== null;
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
