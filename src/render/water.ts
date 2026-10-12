import {
  Constants,
  MaterialDefines,
  MaterialPluginBase,
  MeshBuilder,
  MirrorTexture,
  PBRMaterial,
  Plane,
  RawTexture,
  Scene,
  Texture,
  UniformBuffer,
} from "@babylonjs/core";
import type { AbstractMesh, BaseTexture, Nullable } from "@babylonjs/core";
import type { GraphicsQuality } from "../types/simulation";
import { QUALITY_PRESETS, WATER } from "./renderConfig";
import type { FieldModel } from "./terrain";

/**
 * The water plane reaches past the pond outline and tucks under the bank, so
 * the terrain itself draws the shoreline. It has to cover the outline's
 * outward lobes (see CourseFeature.wobble) with some margin.
 */
const WATER_PLANE_REACH = 1.2;
const WATER_TESSELLATION = 96;

/** Resolution of the baked depth map over the pond. */
const DEPTH_MAP_SIZE_PX = 256;
/** Depth that maps to 1.0 in the depth map, metres; the pond bed is shallower. */
const DEPTH_MAP_RANGE_M = 1.5;
/** Planar reflection resolution on the "high" preset. */
const MIRROR_SIZE_PX = 512;
/**
 * The reflection is redrawn every second frame: ripples hide the one-frame
 * lag, and a full redraw of the reflected scene cost ~2.5 ms per frame on an
 * integrated GPU.
 */
const MIRROR_REFRESH_FRAMES = 2;

const DEPTH_SAMPLER = "pondDepthSampler";
const UNIFORMS = ["pondArea", "pondShallow", "pondDeep", "pondWave", "pondShore"];

export interface WaterController {
  /** Meshes to show in the planar reflection, e.g. trees loaded later. */
  addReflectedMeshes(meshes: AbstractMesh[]): void;
  setQuality(quality: GraphicsQuality): void;
}

const fragmentDefinitions = `
#ifdef POND_WATER
uniform sampler2D ${DEPTH_SAMPLER};

float pondHash(vec2 p) {
  return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453);
}

float pondNoise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(
    mix(pondHash(i), pondHash(i + vec2(1.0, 0.0)), u.x),
    mix(pondHash(i + vec2(0.0, 1.0)), pondHash(i + vec2(1.0, 1.0)), u.x),
    u.y);
}

// Surface slope of a few crossing wind ripples plus a noise chop that breaks
// up their regularity. Returns d(height)/d(x, z).
vec2 pondRippleSlope(vec2 p, float t) {
  vec2 slope = vec2(0.0);
  vec2 d1 = vec2(0.8, 0.6);
  vec2 d2 = vec2(-0.45, 0.89);
  vec2 d3 = vec2(0.96, -0.28);
  vec2 d4 = vec2(-0.7, -0.71);
  slope += d1 * cos(dot(d1, p) * 2.1 + t * 1.6) * 0.14;
  slope += d2 * cos(dot(d2, p) * 3.7 + t * 2.3) * 0.12;
  slope += d3 * cos(dot(d3, p) * 6.3 + t * 3.1) * 0.09;
  slope += d4 * cos(dot(d4, p) * 11.0 + t * 4.2) * 0.06;
  vec2 q = p * 1.3 + vec2(t * 0.21, -t * 0.17);
  float e = 0.15;
  float n = pondNoise(q);
  slope += vec2(pondNoise(q + vec2(e, 0.0)) - n, pondNoise(q + vec2(0.0, e)) - n) / e * 0.22;
  return slope;
}
#endif
`;

// Injected after the albedo is resolved (see TerrainPbrPlugin for the hook).
const fragmentUpdateAlbedo = `
#ifdef POND_WATER
vec2 pondP = vPositionW.xz;
float pondDepth = texture2D(${DEPTH_SAMPLER}, (pondP - pondArea.xy) / pondArea.z).r * pondArea.w;
float pondDistance = length(vEyePosition.xyz - vPositionW);

// Ripples fade with distance before they can alias into sparkle.
vec2 pondSlope = pondRippleSlope(pondP, pondWave.y) * pondWave.x
  * (1.0 - 0.75 * smoothstep(pondWave.z, pondWave.w, pondDistance));
normalW = normalize(vec3(-pondSlope.x, 1.0, -pondSlope.y));

// Shallow water shows the silty bed, deep water the dark body colour.
float pondDeepMix = smoothstep(0.04, pondShore.z, pondDepth);
surfaceAlbedo = mix(pondShallow.rgb, pondDeep.rgb, pondDeepMix);
alpha = mix(pondShallow.a, pondDeep.a, pondDeepMix);

// Lapping foam along the shoreline, broken up by noise.
float pondFoam = (1.0 - smoothstep(pondShore.x, pondShore.y, pondDepth))
  * smoothstep(0.35, 0.75, pondNoise(pondP * 2.2 + vec2(pondWave.y * 0.15, 0.0)));
surfaceAlbedo = mix(surfaceAlbedo, vec3(0.7, 0.72, 0.7), pondFoam * pondShore.w);
alpha = max(alpha, pondFoam * pondShore.w);
#endif
`;

/** Pond surface shading: ripples, depth colour and shoreline foam on a PBR material. */
class PondWaterPlugin extends MaterialPluginBase {
  public constructor(
    material: PBRMaterial,
    private readonly depthMap: Texture,
    private readonly area: { minX: number; minZ: number; sizeM: number },
  ) {
    super(material, "PondWater", 200, { POND_WATER: false });
    this._enable(true);
  }

  public override getClassName(): string {
    return "PondWaterPlugin";
  }

  public override prepareDefines(defines: MaterialDefines): void {
    defines["POND_WATER"] = true;
  }

  public override isReadyForSubMesh(): boolean {
    return this.depthMap.isReady();
  }

  public override getSamplers(samplers: string[]): void {
    samplers.push(DEPTH_SAMPLER);
  }

  public override getUniforms(): { ubo: Array<{ name: string; size: number; type: string }>; fragment: string } {
    return {
      ubo: UNIFORMS.map((name) => ({ name, size: 4, type: "vec4" })),
      fragment: `
#ifdef POND_WATER
${UNIFORMS.map((name) => `uniform vec4 ${name};`).join("\n")}
#endif
`,
    };
  }

  public override bindForSubMesh(uniformBuffer: UniformBuffer): void {
    const timeS = performance.now() * 0.001;
    const { shallow, deep } = WATER;
    uniformBuffer.updateFloat4("pondArea", this.area.minX, this.area.minZ, this.area.sizeM, DEPTH_MAP_RANGE_M);
    uniformBuffer.updateFloat4("pondShallow", shallow.r, shallow.g, shallow.b, WATER.shallowAlpha);
    uniformBuffer.updateFloat4("pondDeep", deep.r, deep.g, deep.b, WATER.deepAlpha);
    uniformBuffer.updateFloat4("pondWave", WATER.rippleStrength, timeS, WATER.rippleFadeStartM, WATER.rippleFadeEndM);
    uniformBuffer.updateFloat4("pondShore", WATER.foamStartM, WATER.foamEndM, WATER.deepAtM, WATER.foamStrength);
    uniformBuffer.setTexture(DEPTH_SAMPLER, this.depthMap);
  }

  public override hasTexture(texture: BaseTexture): boolean {
    return texture === this.depthMap;
  }

  public override getActiveTextures(activeTextures: BaseTexture[]): void {
    activeTextures.push(this.depthMap);
  }

  public override getCustomCode(shaderType: string): Nullable<{ [pointName: string]: string }> {
    if (shaderType !== "fragment") {
      return null;
    }
    return {
      CUSTOM_FRAGMENT_DEFINITIONS: fragmentDefinitions,
      CUSTOM_FRAGMENT_UPDATE_ALPHA: fragmentUpdateAlbedo,
    };
  }
}

/** Water depth over a square around the pond, from the same terrain the ball rolls on. */
const bakeDepthMap = (
  scene: Scene,
  field: FieldModel,
  area: { minX: number; minZ: number; sizeM: number },
): Texture => {
  const size = DEPTH_MAP_SIZE_PX;
  const data = new Uint8Array(size * size * 4);
  for (let row = 0; row < size; row += 1) {
    const z = area.minZ + ((row + 0.5) / size) * area.sizeM;
    for (let column = 0; column < size; column += 1) {
      const x = area.minX + ((column + 0.5) / size) * area.sizeM;
      const depth = Math.max(0, field.waterLevelY - field.getHeight(x, z));
      const index = (row * size + column) * 4;
      data[index] = Math.round(Math.min(1, depth / DEPTH_MAP_RANGE_M) * 255);
      data[index + 3] = 255;
    }
  }
  // Rows run toward +Z and columns toward +X, matching the shader's
  // (p - min) / size lookup with no Y flip.
  const texture = RawTexture.CreateRGBATexture(
    data,
    size,
    size,
    scene,
    false,
    false,
    Constants.TEXTURE_BILINEAR_SAMPLINGMODE,
  );
  texture.name = "pond-depth-map";
  texture.wrapU = Texture.CLAMP_ADDRESSMODE;
  texture.wrapV = Texture.CLAMP_ADDRESSMODE;
  texture.gammaSpace = false;
  return texture;
};

/**
 * The pond: a glossy PBR surface that mirrors the sky through the
 * environment map on every preset, plus a planar reflection of the trees and
 * banks on "high".
 */
export const createPondWater = (
  scene: Scene,
  field: FieldModel,
  initialQuality: GraphicsQuality,
): WaterController => {
  const { pond } = field;
  const water = MeshBuilder.CreateDisc("pond-water", { radius: 1, tessellation: WATER_TESSELLATION }, scene);
  water.rotation.x = Math.PI / 2;
  water.bakeCurrentTransformIntoVertices();
  water.scaling.set(pond.radiusX * WATER_PLANE_REACH, 1, pond.radiusZ * WATER_PLANE_REACH);
  // CourseFeature's local X axis points along (cos a, sin a) in world XZ,
  // which is a Babylon Y rotation of -a.
  water.rotation.y = -pond.angleRad;
  water.position.set(pond.centerX, field.waterLevelY, pond.centerZ);
  water.isPickable = false;
  water.receiveShadows = true;

  const halfSize = Math.max(pond.radiusX, pond.radiusZ) * WATER_PLANE_REACH;
  const area = { minX: pond.centerX - halfSize, minZ: pond.centerZ - halfSize, sizeM: halfSize * 2 };

  const material = new PBRMaterial("pond-water-material", scene);
  material.metallic = 0;
  material.roughness = WATER.roughness;
  material.indexOfRefraction = WATER.indexOfRefraction;
  // Blended, with reflections kept at full strength over the see-through parts.
  material.transparencyMode = PBRMaterial.PBRMATERIAL_ALPHABLEND;
  material.useRadianceOverAlpha = true;
  material.useSpecularOverAlpha = true;
  material.backFaceCulling = false;
  new PondWaterPlugin(material, bakeDepthMap(scene, field, area), area);
  water.material = material;

  const mirror = new MirrorTexture("pond-mirror", MIRROR_SIZE_PX, scene, true);
  // Reflect about the water surface; Babylon planes are n.p + d = 0 with n pointing away from the reflected side.
  mirror.mirrorPlane = new Plane(0, -1, 0, field.waterLevelY);
  mirror.level = WATER.mirrorLevel;
  mirror.refreshRate = MIRROR_REFRESH_FRAMES;
  const skybox = scene.getMeshByName("sky-box");
  mirror.renderList = skybox ? [skybox] : [];

  const applyQuality = (quality: GraphicsQuality): void => {
    // Without a reflection texture the material falls back to the scene's sky map.
    material.reflectionTexture = QUALITY_PRESETS[quality].waterReflection ? mirror : null;
  };
  applyQuality(initialQuality);

  return {
    addReflectedMeshes(meshes) {
      mirror.renderList?.push(...meshes);
    },
    setQuality: applyQuality,
  };
};
