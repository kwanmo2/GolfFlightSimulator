import { HDRCubeTexture, PBRMaterial, Scene } from "@babylonjs/core";
import { ENVIRONMENT, ENVIRONMENT_ROTATION_Y_RAD } from "./renderConfig";

/** Arguments to HDRCubeTexture, named so the positional call stays readable. */
const NO_MIPMAP = false;
const GENERATE_HARMONICS = true;
/** Physically based materials need the panorama in linear space. */
const GAMMA_SPACE = false;
/** Prefiltered mips let rough surfaces sample blurred sky light. */
const PREFILTER_ON_LOAD = true;
/** Sky blur for the visible skybox; zero keeps the clouds sharp. */
const SKYBOX_BLUR = 0;

/**
 * Load the sky panorama as both the visible sky and the image-based light for
 * every physically based material. The panorama is turned so its sun matches
 * the directional light (see ENVIRONMENT_ROTATION_Y_RAD). If it fails to load
 * the scene keeps its plain clear colour and the directional light.
 */
export const createSky = (scene: Scene): void => {
  const texture = new HDRCubeTexture(
    ENVIRONMENT.url,
    scene,
    ENVIRONMENT.cubeSizePx,
    NO_MIPMAP,
    GENERATE_HARMONICS,
    GAMMA_SPACE,
    PREFILTER_ON_LOAD,
    null,
    (message) => {
      console.warn("Sky panorama failed to load; continuing with a plain sky.", message);
    },
  );
  texture.rotationY = ENVIRONMENT_ROTATION_Y_RAD;

  scene.environmentTexture = texture;
  scene.environmentIntensity = ENVIRONMENT.lightingIntensity;

  const skybox = scene.createDefaultSkybox(texture, true, ENVIRONMENT.skyboxSizeM, SKYBOX_BLUR);
  if (skybox) {
    // The helper gives the skybox its own clone of the texture (it needs a
    // different coordinates mode), and HDRCubeTexture.clone drops the rotation.
    const skyTexture = skybox.material instanceof PBRMaterial ? skybox.material.reflectionTexture : null;
    if (skyTexture instanceof HDRCubeTexture) {
      skyTexture.rotationY = ENVIRONMENT_ROTATION_Y_RAD;
    }
    skybox.name = "sky-box";
    skybox.isPickable = false;
    // The sky is the haze's source, not something seen through it.
    skybox.applyFog = false;
  }
};
