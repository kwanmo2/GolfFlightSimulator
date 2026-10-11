import {
  MaterialDefines,
  MaterialPluginBase,
  PBRMaterial,
  UniformBuffer,
} from "@babylonjs/core";
import type { BaseTexture, Color3, Nullable, Texture } from "@babylonjs/core";
import type { TerrainLayer, TerrainTextureArrays } from "./terrainTextures";

/** Linear albedo for each course surface. Tee boxes use the fairway colour. */
export interface TerrainSurfaceColors {
  rough: Color3;
  /** Collar of slightly longer grass just outside the fairway edge. */
  firstCut: Color3;
  fairway: Color3;
  fringe: Color3;
  green: Color3;
  sand: Color3;
}

/**
 * Mask weight at which each surface starts. Matching the physics surface
 * classification keeps the painted edges where the ball's behaviour changes.
 */
export interface TerrainThresholds {
  fairway: number;
  green: number;
  bunker: number;
  fringe: number;
}

/** One value per texture layer. */
export type PerLayer = Record<TerrainLayer, number>;

export interface TerrainShadingParams {
  /** Width of the first-cut collar, in fairway mask weight below the fairway threshold. */
  firstCutWeight: number;
  /**
   * Minimum edge softness in mask weight. Edges are otherwise antialiased to
   * about one pixel, which looks cut out when the camera is close.
   */
  minEdgeSoftness: number;
  /** Brightness swing between fairway mowing stripes when looked at along the cut. */
  stripeContrast: number;
  /** Width of one mowing square on the green, metres. */
  greenCheckerWidthM: number;
  greenCheckerContrast: number;
  /** World size of one texture repeat close to the camera, metres. */
  tileSizeM: PerLayer;
  /** Normal map strength; longer grass reads rougher. */
  normalStrength: PerLayer;
  /** How much of the photo's brightness variation survives (0 = flat colour, >1 exaggerates). */
  detailContrast: PerLayer;
  /** Brightness swing of the few-metre mottling that breaks up mown grass. */
  mottleStrength: number;
  /** Size of one mottling blotch, metres. */
  mottleScaleM: number;
  /** How much of the photo's hue variation survives (0 = brightness only). */
  detailSaturation: number;
  /** Camera distance where the far, larger texture scale starts to blend in... */
  farBlendStartM: number;
  /** ...and where it has fully taken over. */
  farBlendEndM: number;
  /** Far texture scale as a multiple of tileSizeM. */
  farTileMultiplier: number;
  /** Spacing between rake furrows in the bunkers, metres. */
  rakeSpacingM: number;
  rakeStrength: number;
  /** Direction the furrows run across, radians from +X. */
  rakeAngleRad: number;
  /** Camera distance beyond which the rake furrows are no longer drawn. */
  rakeFadeEndM: number;
}

const MASK_SAMPLER = "terrainMaskSampler";
const DETAIL_SAMPLER = "terrainDetailSampler";
const NORMAL_SAMPLER = "terrainNormalSampler";

const COLOR_UNIFORMS: Array<[keyof TerrainSurfaceColors, string]> = [
  ["rough", "terrainRough"],
  ["firstCut", "terrainFirstCut"],
  ["fairway", "terrainFairway"],
  ["fringe", "terrainFringe"],
  ["green", "terrainGreen"],
  ["sand", "terrainSand"],
];
const VECTOR_UNIFORMS = [
  "terrainThresholds",
  "terrainEdge",
  "terrainMowing",
  "terrainTileM",
  "terrainNormalStrength",
  "terrainDetailContrast",
  "terrainFar",
  "terrainRake",
  "terrainMottle",
];

const fragmentDefinitions = `
#ifdef TERRAIN_STYLE
uniform sampler2D ${MASK_SAMPLER};
#ifdef TERRAIN_DETAIL
uniform highp sampler2DArray ${DETAIL_SAMPLER};
uniform highp sampler2DArray ${NORMAL_SAMPLER};
#endif

vec2 terrainRotate(vec2 p, float angle) {
  float c = cos(angle);
  float s = sin(angle);
  return vec2(c * p.x - s * p.y, s * p.x + c * p.y);
}

// Antialiased step across a mask threshold.
float terrainStep(float weight, float threshold, float minSoftness) {
  float softness = max(fwidth(weight), minSoftness);
  return smoothstep(threshold - softness, threshold + softness, weight);
}

float terrainHash(vec2 p) {
  return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453);
}

float terrainNoise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(
    mix(terrainHash(i), terrainHash(i + vec2(1.0, 0.0)), u.x),
    mix(terrainHash(i + vec2(0.0, 1.0)), terrainHash(i + vec2(1.0, 1.0)), u.x),
    u.y);
}

#ifdef TERRAIN_DETAIL
// One texture layer at one scale. With TERRAIN_NOTILE, two copies shifted by
// noise-picked offsets are cross-faded (Quilez, "texture repetition", method
// 3), which hides the repeat for one extra fetch per map. Gradients are
// passed in because this runs inside branches.
void terrainSample(float layer, vec2 uv, vec2 gx, vec2 gy, out vec4 detail, out vec4 normal) {
#ifdef TERRAIN_NOTILE
  float level = terrainNoise(uv * 0.11) * 8.0;
  float index = floor(level);
  vec2 offsetA = sin(vec2(3.0, 7.0) * index);
  vec2 offsetB = sin(vec2(3.0, 7.0) * (index + 1.0));
  vec4 detailA = textureGrad(${DETAIL_SAMPLER}, vec3(uv + offsetA, layer), gx, gy);
  vec4 detailB = textureGrad(${DETAIL_SAMPLER}, vec3(uv + offsetB, layer), gx, gy);
  float blend = smoothstep(0.2, 0.8, fract(level) - 0.1 * dot(detailA.rgb - detailB.rgb, vec3(1.0)));
  detail = mix(detailA, detailB, blend);
  normal = mix(
    textureGrad(${NORMAL_SAMPLER}, vec3(uv + offsetA, layer), gx, gy),
    textureGrad(${NORMAL_SAMPLER}, vec3(uv + offsetB, layer), gx, gy),
    blend);
#else
  detail = textureGrad(${DETAIL_SAMPLER}, vec3(uv, layer), gx, gy);
  normal = textureGrad(${NORMAL_SAMPLER}, vec3(uv, layer), gx, gy);
#endif
}

// Add one layer's detail (a multiplier around 1) and tangent-space normal,
// weighted. Close up the layer tiles at tileM; far away a larger copy takes
// over so the repeat is never visible across a fairway.
void terrainLayer(float layer, float weight, float tileM, float normalStrength, float contrast,
    vec2 p, vec2 dPdx, vec2 dPdy, float farMix,
    inout vec3 detailSum, inout vec3 normalSum, inout float weightSum) {
  if (weight < 0.002) {
    return;
  }
  vec4 detail = vec4(0.0);
  vec4 normal = vec4(0.0);
  vec4 sampledDetail;
  vec4 sampledNormal;
  if (farMix < 0.999) {
    terrainSample(layer, p / tileM, dPdx / tileM, dPdy / tileM, sampledDetail, sampledNormal);
    detail += sampledDetail * (1.0 - farMix);
    normal += sampledNormal * (1.0 - farMix);
  }
  if (farMix > 0.001) {
    float farTileM = tileM * terrainFar.z;
    terrainSample(layer, p / farTileM, dPdx / farTileM, dPdy / farTileM, sampledDetail, sampledNormal);
    detail += sampledDetail * farMix;
    normal += sampledNormal * farMix;
  }
  vec3 variation = detail.rgb * 2.0;
  float luma = dot(variation, vec3(0.2126, 0.7152, 0.0722));
  variation = mix(vec3(luma), variation, terrainFar.w);
  variation = mix(vec3(1.0), variation, contrast);
  vec3 tangentNormal = normal.xyz * 2.0 - 1.0;
  tangentNormal.xy *= normalStrength;
  detailSum += variation * weight;
  normalSum += tangentNormal * weight;
  weightSum += weight;
}
#endif
#endif
`;

// Injected right after the PBR albedo is resolved; Babylon's PBR shader has
// no dedicated albedo hook. normalW is final by this point and lighting and
// reflections read it afterwards, so the terrain normal map is applied here too.
const fragmentUpdateAlbedo = `
#ifdef TERRAIN_STYLE
// Mask RGBA: R = fairway/tee, G = green, B = bunker, A = fringe; rough is the remainder.
vec4 terrainMask = texture2D(${MASK_SAMPLER}, vAlbedoUV);
vec2 terrainP = vPositionW.xz;
vec3 terrainToEye = vEyePosition.xyz - vPositionW;
float terrainDistance = length(terrainToEye);
vec3 terrainView = terrainToEye / max(terrainDistance, 0.0001);

// Exclusive surface weights, stacked rough < first cut < fairway < fringe < green < sand.
float terrainSoftness = terrainEdge.y;
float terrainOverFirst = terrainStep(terrainMask.r, terrainThresholds.x - terrainEdge.x, terrainSoftness);
float terrainOverFairway = terrainStep(terrainMask.r, terrainThresholds.x, terrainSoftness);
float terrainOverFringe = terrainStep(terrainMask.a, terrainThresholds.w, terrainSoftness);
float terrainOverGreen = terrainStep(terrainMask.g, terrainThresholds.y, terrainSoftness);
float terrainOverSand = terrainStep(terrainMask.b, terrainThresholds.z, terrainSoftness);
float terrainSandW = terrainOverSand;
float terrainGreenW = terrainOverGreen * (1.0 - terrainSandW);
float terrainFringeW = terrainOverFringe * (1.0 - terrainOverGreen) * (1.0 - terrainSandW);
float terrainAboveFairway = (1.0 - terrainOverFringe) * (1.0 - terrainOverGreen) * (1.0 - terrainSandW);
float terrainFairwayW = terrainOverFairway * terrainAboveFairway;
float terrainFirstW = terrainOverFirst * (1.0 - terrainOverFairway) * terrainAboveFairway;
float terrainRoughW = (1.0 - terrainOverFirst) * (1.0 - terrainOverFairway) * terrainAboveFairway;

// Mowing: grass laid away from the viewer shows the pale sides of its blades,
// grass laid toward them the darker tips. The stripe pattern therefore flips
// as the camera turns, and stays faintly visible from straight above.
vec2 terrainLook = -terrainView.xz;
float terrainLookLength = length(terrainLook);
terrainLook = terrainLookLength > 0.0001 ? terrainLook / terrainLookLength : vec2(0.0, 1.0);
float terrainGrazing = 1.0 - abs(terrainView.y);
// The tint map's alpha is a triangle wave across the stripes; 0.5 is an edge.
float terrainStripeSide = terrainStep(albedoTexture.a, 0.5, 0.0) * 2.0 - 1.0;
float terrainFairwayMow = 1.0 + terrainMowing.x * terrainStripeSide * (0.35 + 0.65 * terrainLook.y * terrainGrazing);
vec2 terrainMowP = terrainRotate(terrainP, 0.785398) / terrainMowing.y;
float terrainChecker = (step(0.5, fract(terrainMowP.x)) - 0.5) * (step(0.5, fract(terrainMowP.y)) - 0.5) * 4.0;
float terrainGreenMow = 1.0 + terrainMowing.z * terrainChecker * (0.35 + 0.65 * dot(terrainLook, vec2(0.7071)) * terrainGrazing);

vec3 terrainColor =
  terrainRough.rgb * terrainRoughW +
  terrainFirstCut.rgb * terrainFirstW +
  terrainFairway.rgb * terrainFairwayMow * terrainFairwayW +
  terrainFringe.rgb * terrainFringeW +
  terrainGreen.rgb * terrainGreenMow * terrainGreenW +
  terrainSand.rgb * terrainSandW;

// Few-metre mottling on the grass, between the tint map's broad patches and
// the photo detail: what makes mown turf look uneven at eye level.
float terrainMottleShade = 1.0 + terrainMottle.x * (1.0 - terrainSandW) * (
  (terrainNoise(terrainP / terrainMottle.y) - 0.5) * 1.4 +
  (terrainNoise(terrainP / terrainMottle.y * 3.7 + 17.0) - 0.5) * 0.6);

// The albedo texture is a linear tint map centred on mid grey.
surfaceAlbedo = terrainColor * surfaceAlbedo * 2.0 * terrainMottleShade;

#ifdef TERRAIN_DETAIL
vec2 terrainDPdx = dFdx(terrainP);
vec2 terrainDPdy = dFdy(terrainP);
float terrainFarMix = smoothstep(terrainFar.x, terrainFar.y, terrainDistance);
vec3 terrainDetailSum = vec3(0.0);
vec3 terrainNormalSum = vec3(0.0);
float terrainWeightSum = 0.0;
terrainLayer(0.0, terrainRoughW, terrainTileM.x, terrainNormalStrength.x, terrainDetailContrast.x,
  terrainP, terrainDPdx, terrainDPdy, terrainFarMix, terrainDetailSum, terrainNormalSum, terrainWeightSum);
terrainLayer(1.0, terrainFirstW + terrainFairwayW + terrainFringeW, terrainTileM.y, terrainNormalStrength.y, terrainDetailContrast.y,
  terrainP, terrainDPdx, terrainDPdy, terrainFarMix, terrainDetailSum, terrainNormalSum, terrainWeightSum);
terrainLayer(2.0, terrainGreenW, terrainTileM.z, terrainNormalStrength.z, terrainDetailContrast.z,
  terrainP, terrainDPdx, terrainDPdy, terrainFarMix, terrainDetailSum, terrainNormalSum, terrainWeightSum);
terrainLayer(3.0, terrainSandW, terrainTileM.w, terrainNormalStrength.w, terrainDetailContrast.w,
  terrainP, terrainDPdx, terrainDPdy, terrainFarMix, terrainDetailSum, terrainNormalSum, terrainWeightSum);
float terrainWeightNorm = 1.0 / max(terrainWeightSum, 0.001);
surfaceAlbedo *= terrainDetailSum * terrainWeightNorm;
vec3 terrainTangentNormal = terrainNormalSum * terrainWeightNorm;

// Rake furrows: a wobbling sine ridge pattern in the sand, close up only.
vec2 terrainRakeDir = vec2(cos(terrainRake.z), sin(terrainRake.z));
float terrainRakePhase = dot(terrainP, terrainRakeDir) / terrainRake.x * 6.2831853 + terrainNoise(terrainP * 0.35) * 2.5;
float terrainRakeFade = terrainSandW * (1.0 - smoothstep(0.0, terrainRake.w, terrainDistance));
vec2 terrainRakeSlope = terrainRakeDir * cos(terrainRakePhase) * terrainRake.y * terrainRakeFade;
// Tangent space here is (+X, -Z, up), so a world XZ slope maps to (x, -z).
terrainTangentNormal.xy += vec2(terrainRakeSlope.x, -terrainRakeSlope.y);

// Tangent frame from the planar XZ mapping: T follows +X, B follows -Z
// (image rows run toward +Z), both lying in the surface.
vec3 terrainN = normalW;
vec3 terrainT = normalize(vec3(1.0, 0.0, 0.0) - terrainN * terrainN.x);
vec3 terrainB = cross(terrainN, terrainT);
normalW = normalize(terrainT * terrainTangentNormal.x + terrainB * terrainTangentNormal.y + terrainN * max(terrainTangentNormal.z, 0.05));
#endif
#endif
`;

/**
 * Paints the course surfaces on the PBR terrain material: the splat mask
 * (sampled through the albedo UV, a planar map of the field) picks the surface,
 * the albedo texture carries the large-scale tint and the mowing pattern, and
 * once loaded the photo detail and normal arrays add the grass and sand.
 */
export class TerrainPbrPlugin extends MaterialPluginBase {
  private mask: Nullable<Texture> = null;
  private colors: Nullable<TerrainSurfaceColors> = null;
  private thresholds: Nullable<TerrainThresholds> = null;
  private params: Nullable<TerrainShadingParams> = null;
  private textures: Nullable<TerrainTextureArrays> = null;
  private antiTiling = true;

  public constructor(material: PBRMaterial) {
    super(material, "TerrainPbr", 200, { TERRAIN_STYLE: false, TERRAIN_DETAIL: false, TERRAIN_NOTILE: false });
  }

  public setStyle(
    mask: Texture,
    colors: TerrainSurfaceColors,
    thresholds: TerrainThresholds,
    params: TerrainShadingParams,
  ): void {
    this.mask = mask;
    this.colors = colors;
    this.thresholds = thresholds;
    this.params = params;
    this._enable(true);
    this.markAllDefinesAsDirty();
  }

  /** Photo detail and normal maps; until set, the surfaces are flat colours. */
  public setTextures(textures: TerrainTextureArrays): void {
    this.textures = textures;
    this.markAllDefinesAsDirty();
  }

  /** The anti-tiling cross-fade doubles the texture fetches; quality presets may drop it. */
  public setAntiTiling(enabled: boolean): void {
    if (enabled !== this.antiTiling) {
      this.antiTiling = enabled;
      this.markAllDefinesAsDirty();
    }
  }

  public override getClassName(): string {
    return "TerrainPbrPlugin";
  }

  public override prepareDefines(defines: MaterialDefines): void {
    defines["TERRAIN_STYLE"] = this.mask !== null;
    defines["TERRAIN_DETAIL"] = this.textures !== null;
    defines["TERRAIN_NOTILE"] = this.textures !== null && this.antiTiling;
  }

  public override isReadyForSubMesh(): boolean {
    return (
      (this.mask?.isReady() ?? true) &&
      (this.textures ? this.textures.detail.isReady() && this.textures.normal.isReady() : true)
    );
  }

  public override getSamplers(samplers: string[]): void {
    samplers.push(MASK_SAMPLER, DETAIL_SAMPLER, NORMAL_SAMPLER);
  }

  public override getUniforms(): { ubo: Array<{ name: string; size: number; type: string }>; fragment: string } {
    const names = [...COLOR_UNIFORMS.map(([, name]) => name), ...VECTOR_UNIFORMS];
    return {
      ubo: names.map((name) => ({ name, size: 4, type: "vec4" })),
      fragment: `
#ifdef TERRAIN_STYLE
${names.map((name) => `uniform vec4 ${name};`).join("\n")}
#endif
`,
    };
  }

  public override bindForSubMesh(uniformBuffer: UniformBuffer): void {
    if (!this.mask || !this.colors || !this.thresholds || !this.params) {
      return;
    }
    for (const [key, name] of COLOR_UNIFORMS) {
      const color = this.colors[key];
      uniformBuffer.updateFloat4(name, color.r, color.g, color.b, 1);
    }
    const t = this.thresholds;
    const p = this.params;
    const perLayer = (name: string, values: PerLayer): void =>
      uniformBuffer.updateFloat4(name, values.rough, values.fairway, values.green, values.sand);
    uniformBuffer.updateFloat4("terrainThresholds", t.fairway, t.green, t.bunker, t.fringe);
    uniformBuffer.updateFloat4("terrainEdge", p.firstCutWeight, p.minEdgeSoftness, 0, 0);
    uniformBuffer.updateFloat4("terrainMowing", p.stripeContrast, p.greenCheckerWidthM, p.greenCheckerContrast, 0);
    perLayer("terrainTileM", p.tileSizeM);
    perLayer("terrainNormalStrength", p.normalStrength);
    perLayer("terrainDetailContrast", p.detailContrast);
    uniformBuffer.updateFloat4("terrainFar", p.farBlendStartM, p.farBlendEndM, p.farTileMultiplier, p.detailSaturation);
    uniformBuffer.updateFloat4("terrainRake", p.rakeSpacingM, p.rakeStrength, p.rakeAngleRad, p.rakeFadeEndM);
    uniformBuffer.updateFloat4("terrainMottle", p.mottleStrength, p.mottleScaleM, 0, 0);
    uniformBuffer.setTexture(MASK_SAMPLER, this.mask);
    if (this.textures) {
      uniformBuffer.setTexture(DETAIL_SAMPLER, this.textures.detail);
      uniformBuffer.setTexture(NORMAL_SAMPLER, this.textures.normal);
    }
  }

  public override hasTexture(texture: BaseTexture): boolean {
    return (
      this.mask === texture || this.textures?.detail === texture || this.textures?.normal === texture
    );
  }

  public override getActiveTextures(activeTextures: BaseTexture[]): void {
    if (this.mask) {
      activeTextures.push(this.mask);
    }
    if (this.textures) {
      activeTextures.push(this.textures.detail, this.textures.normal);
    }
  }

  public override dispose(forceDisposeTextures?: boolean): void {
    if (forceDisposeTextures) {
      this.mask?.dispose();
      this.textures?.detail.dispose();
      this.textures?.normal.dispose();
    }
    this.mask = null;
    this.colors = null;
    this.textures = null;
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
