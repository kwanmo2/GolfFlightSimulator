import {
  MaterialDefines,
  MaterialPluginBase,
  StandardMaterial,
  UniformBuffer,
} from "@babylonjs/core";
import type { BaseTexture, Nullable, Texture } from "@babylonjs/core";

/**
 * Tiled detail textures for each course surface, blended by the splat mask.
 * The mask is sampled through the material's diffuse UV (a planar map of the
 * field), the detail textures through world XZ so tiling is in metres.
 */
export interface TerrainSplatLayers {
  /** RGBA weights: R = fairway/tee, G = green, B = bunker, A = fringe. Rough is the remainder. */
  mask: Texture;
  roughColor: Texture;
  roughNormal: Texture;
  fairwayColor: Texture;
  fairwayNormal: Texture;
  greenColor: Texture;
  greenNormal: Texture;
  sandColor: Texture;
  sandNormal: Texture;
}

export interface TerrainSplatTiling {
  /** Tiles per metre for each layer. */
  rough: number;
  fairway: number;
  green: number;
  sand: number;
}

export interface TerrainSplatParams {
  /** Scale applied to the tangent-space normal perturbation. */
  normalStrength: number;
  /** Width of one mowing square on the green, metres. */
  greenCheckerWidthM: number;
  /** Distance between rake grooves in the bunkers, metres. */
  rakeSpacingM: number;
  /** Slope amplitude of the rake grooves. */
  rakeStrength: number;
}

const SAMPLER_NAMES: Array<keyof TerrainSplatLayers> = [
  "mask",
  "roughColor",
  "roughNormal",
  "fairwayColor",
  "fairwayNormal",
  "greenColor",
  "greenNormal",
  "sandColor",
  "sandNormal",
];

const samplerUniform = (layer: keyof TerrainSplatLayers): string => `splat_${layer}`;

const fragmentDefinitions = `
#ifdef TERRAIN_SPLAT
${SAMPLER_NAMES.map((name) => `uniform sampler2D ${samplerUniform(name)};`).join("\n")}

vec2 splatRotate(vec2 p, float angle) {
  float c = cos(angle);
  float s = sin(angle);
  return vec2(c * p.x - s * p.y, s * p.x + c * p.y);
}

// Two samples at unrelated scales hide the repeat of a single tile when the
// camera pulls back to the broadcast and dispersion views.
vec3 splatColor(sampler2D layer, vec2 p, float tiling) {
  vec3 near = texture2D(layer, p * tiling).rgb;
  vec3 far = texture2D(layer, splatRotate(p, 0.7) * tiling * 0.37).rgb;
  return mix(near, far, 0.4);
}

vec3 splatNormal(sampler2D layer, vec2 p, float tiling) {
  return texture2D(layer, p * tiling).xyz * 2.0 - 1.0;
}
#endif
`;

const fragmentUpdateDiffuse = `
#ifdef TERRAIN_SPLAT
vec4 splatWeights = texture2D(${samplerUniform("mask")}, vDiffuseUV);
float splatRough = clamp(1.0 - splatWeights.r - splatWeights.g - splatWeights.b - splatWeights.a, 0.0, 1.0);
vec2 splatP = vPositionW.xz;

vec3 splatRoughC = splatColor(${samplerUniform("roughColor")}, splatP, splatTiling.x) * vec3(0.98, 1.0, 0.92);
vec3 splatFairwayC = splatColor(${samplerUniform("fairwayColor")}, splatP, splatTiling.y);
vec3 splatGreenC = splatColor(${samplerUniform("greenColor")}, splatP, splatTiling.z) * vec3(0.9, 1.0, 0.86);
vec3 splatSandC = splatColor(${samplerUniform("sandColor")}, splatP, splatTiling.w) * vec3(0.56, 0.53, 0.45);

// Diagonal mowing checker on the green: alternate squares catch the light differently.
vec2 mowP = splatRotate(splatP, 0.785398) / splatParams.y;
float mowChecker = (step(0.5, fract(mowP.x)) - 0.5) * (step(0.5, fract(mowP.y)) - 0.5) * 4.0;
splatGreenC *= 1.0 + mowChecker * 0.045;

vec3 splatDetail =
  splatRoughC * splatRough +
  splatFairwayC * splatWeights.r +
  splatFairwayC * 0.88 * splatWeights.a +
  splatGreenC * splatWeights.g +
  splatSandC * splatWeights.b;

// The diffuse texture is a tint map centred on mid grey.
baseColor.rgb = splatDetail * baseColor.rgb * 2.0;
#endif
`;

const fragmentBeforeLights = `
#ifdef TERRAIN_SPLAT
vec3 splatN =
  splatNormal(${samplerUniform("roughNormal")}, splatP, splatTiling.x) * splatRough +
  splatNormal(${samplerUniform("fairwayNormal")}, splatP, splatTiling.y) * (splatWeights.r + splatWeights.a) +
  splatNormal(${samplerUniform("greenNormal")}, splatP, splatTiling.z) * splatWeights.g +
  splatNormal(${samplerUniform("sandNormal")}, splatP, splatTiling.w) * splatWeights.b * 1.8;

// Rake grooves: a height ripple across the sand, expressed as its slope.
// The phase is wrapped before cos() so it stays accurate hundreds of metres
// from the origin, and the ripple fades out once it gets denser than a few
// pixels so it cannot alias into moire from the far cameras.
vec2 rakeDir = normalize(vec2(0.82, 0.57));
float rakeCycles = dot(splatP, rakeDir) / splatParams.z;
float rakePhase = fract(rakeCycles) * 6.2831853;
float rakeFade = 1.0 - smoothstep(0.12, 0.3, fwidth(rakeCycles));
vec2 rakeSlope = -rakeDir * cos(rakePhase) * splatParams.w * splatWeights.b * rakeFade;

// Tangent frame for a mostly upward-facing surface: U follows world +X, V world +Z.
vec3 splatT = normalize(cross(vec3(0.0, 0.0, 1.0), normalW));
vec3 splatB = cross(normalW, splatT);
vec2 splatTilt = splatN.xy * splatParams.x + rakeSlope;
normalW = normalize(normalW + splatT * splatTilt.x + splatB * splatTilt.y);
#endif
`;

export class TerrainSplatPlugin extends MaterialPluginBase {
  private layers: Nullable<TerrainSplatLayers> = null;
  private tiling: TerrainSplatTiling = { rough: 0.45, fairway: 0.5, green: 0.7, sand: 0.6 };
  private params: TerrainSplatParams = {
    normalStrength: 0.7,
    greenCheckerWidthM: 2,
    // Real rake lines sit a few centimetres apart; wider spacing keeps them
    // visible from the broadcast camera instead of dissolving into the mips.
    rakeSpacingM: 0.25,
    rakeStrength: 0.55,
  };

  public constructor(material: StandardMaterial) {
    super(material, "TerrainSplat", 200, { TERRAIN_SPLAT: false });
  }

  public setLayers(
    layers: TerrainSplatLayers,
    tiling?: Partial<TerrainSplatTiling>,
    params?: Partial<TerrainSplatParams>,
  ): void {
    this.layers = layers;
    this.tiling = { ...this.tiling, ...tiling };
    this.params = { ...this.params, ...params };
    this._enable(true);
    this.markAllDefinesAsDirty();
  }

  public override getClassName(): string {
    return "TerrainSplatPlugin";
  }

  public override prepareDefines(defines: MaterialDefines): void {
    defines["TERRAIN_SPLAT"] = this.layers !== null;
  }

  public override isReadyForSubMesh(): boolean {
    if (!this.layers) {
      return true;
    }
    return SAMPLER_NAMES.every((name) => this.layers![name].isReady());
  }

  public override getSamplers(samplers: string[]): void {
    samplers.push(...SAMPLER_NAMES.map(samplerUniform));
  }

  public override getUniforms(): { ubo: Array<{ name: string; size: number; type: string }>; fragment: string } {
    return {
      ubo: [
        { name: "splatTiling", size: 4, type: "vec4" },
        { name: "splatParams", size: 4, type: "vec4" },
      ],
      fragment: `
#ifdef TERRAIN_SPLAT
uniform vec4 splatTiling;
uniform vec4 splatParams;
#endif
`,
    };
  }

  public override bindForSubMesh(uniformBuffer: UniformBuffer): void {
    if (!this.layers) {
      return;
    }
    uniformBuffer.updateFloat4(
      "splatTiling",
      this.tiling.rough,
      this.tiling.fairway,
      this.tiling.green,
      this.tiling.sand,
    );
    uniformBuffer.updateFloat4(
      "splatParams",
      this.params.normalStrength,
      this.params.greenCheckerWidthM,
      this.params.rakeSpacingM,
      this.params.rakeStrength,
    );
    for (const name of SAMPLER_NAMES) {
      uniformBuffer.setTexture(samplerUniform(name), this.layers[name]);
    }
  }

  public override hasTexture(texture: BaseTexture): boolean {
    return this.layers !== null && SAMPLER_NAMES.some((name) => this.layers![name] === texture);
  }

  public override getActiveTextures(activeTextures: BaseTexture[]): void {
    if (this.layers) {
      activeTextures.push(...SAMPLER_NAMES.map((name) => this.layers![name]));
    }
  }

  public override dispose(forceDisposeTextures?: boolean): void {
    if (forceDisposeTextures && this.layers) {
      for (const name of SAMPLER_NAMES) {
        this.layers[name].dispose();
      }
    }
    this.layers = null;
  }

  public override getCustomCode(shaderType: string): Nullable<{ [pointName: string]: string }> {
    if (shaderType !== "fragment") {
      return null;
    }
    return {
      CUSTOM_FRAGMENT_DEFINITIONS: fragmentDefinitions,
      CUSTOM_FRAGMENT_UPDATE_DIFFUSE: fragmentUpdateDiffuse,
      CUSTOM_FRAGMENT_BEFORE_LIGHTS: fragmentBeforeLights,
    };
  }
}
