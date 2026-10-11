import {
  MaterialDefines,
  MaterialPluginBase,
  StandardMaterial,
  UniformBuffer,
} from "@babylonjs/core";
import type { BaseTexture, Color3, Nullable, Texture } from "@babylonjs/core";

/** Flat palette colour for each course surface. Tee boxes use the fairway colour. */
export interface TerrainStyleColors {
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
export interface TerrainStyleThresholds {
  fairway: number;
  green: number;
  bunker: number;
  fringe: number;
}

export interface TerrainStyleParams {
  /** Width of the first-cut collar, in fairway mask weight below the fairway threshold. */
  firstCutWeight: number;
  /** Width of one mowing square on the green, metres. */
  greenCheckerWidthM: number;
  /** Brightness swing between alternate mowing squares on the green. */
  greenCheckerContrast: number;
  /**
   * Minimum edge softness in mask weight. Edges are otherwise antialiased to
   * about one pixel, which looks cut out when the camera is close.
   */
  minEdgeSoftness: number;
}

const MASK_SAMPLER = "terrainStyle_mask";
const COLOR_UNIFORMS: Array<[keyof TerrainStyleColors, string]> = [
  ["rough", "terrainStyleRough"],
  ["firstCut", "terrainStyleFirstCut"],
  ["fairway", "terrainStyleFairway"],
  ["fringe", "terrainStyleFringe"],
  ["green", "terrainStyleGreen"],
  ["sand", "terrainStyleSand"],
];

const fragmentDefinitions = `
#ifdef TERRAIN_STYLE
uniform sampler2D ${MASK_SAMPLER};

vec2 terrainStyleRotate(vec2 p, float angle) {
  float c = cos(angle);
  float s = sin(angle);
  return vec2(c * p.x - s * p.y, s * p.x + c * p.y);
}

// Crisp, antialiased step across a mask threshold.
float terrainStyleEdge(float weight, float threshold, float minSoftness) {
  float softness = max(fwidth(weight), minSoftness);
  return smoothstep(threshold - softness, threshold + softness, weight);
}
#endif
`;

const fragmentUpdateDiffuse = `
#ifdef TERRAIN_STYLE
// RGBA weights: R = fairway/tee, G = green, B = bunker, A = fringe. Rough is the remainder.
vec4 styleMask = texture2D(${MASK_SAMPLER}, vDiffuseUV);
vec2 styleP = vPositionW.xz;

// Diagonal mowing checker on the green: alternate squares catch the light differently.
vec2 mowP = terrainStyleRotate(styleP, 0.785398) / terrainStyleParams.y;
float mowChecker = (step(0.5, fract(mowP.x)) - 0.5) * (step(0.5, fract(mowP.y)) - 0.5) * 4.0;
vec3 styleGreen = terrainStyleGreen.rgb * (1.0 + mowChecker * terrainStyleParams.z);

vec3 styleColor = terrainStyleRough.rgb;
styleColor = mix(styleColor, terrainStyleFirstCut.rgb,
  terrainStyleEdge(styleMask.r, terrainStyleThresholds.x - terrainStyleParams.x, terrainStyleParams.w));
styleColor = mix(styleColor, terrainStyleFairway.rgb, terrainStyleEdge(styleMask.r, terrainStyleThresholds.x, terrainStyleParams.w));
styleColor = mix(styleColor, terrainStyleFringe.rgb, terrainStyleEdge(styleMask.a, terrainStyleThresholds.w, terrainStyleParams.w));
styleColor = mix(styleColor, styleGreen, terrainStyleEdge(styleMask.g, terrainStyleThresholds.y, terrainStyleParams.w));
styleColor = mix(styleColor, terrainStyleSand.rgb, terrainStyleEdge(styleMask.b, terrainStyleThresholds.z, terrainStyleParams.w));

// The diffuse texture is a tint map centred on mid grey.
baseColor.rgb = styleColor * baseColor.rgb * 2.0;
#endif
`;

/**
 * Paints the course in flat palette colours. The splat mask (sampled through
 * the material's diffuse UV, a planar map of the field) decides which surface
 * each pixel shows; the diffuse texture carries the large-scale tint.
 */
export class TerrainStylePlugin extends MaterialPluginBase {
  private mask: Nullable<Texture> = null;
  private colors: Nullable<TerrainStyleColors> = null;
  private thresholds: TerrainStyleThresholds = { fairway: 0.5, green: 0.5, bunker: 0.5, fringe: 0.5 };
  private params: TerrainStyleParams = {
    firstCutWeight: 0.16,
    greenCheckerWidthM: 2.4,
    greenCheckerContrast: 0.035,
    minEdgeSoftness: 0.012,
  };

  public constructor(material: StandardMaterial) {
    super(material, "TerrainStyle", 200, { TERRAIN_STYLE: false });
  }

  public setStyle(
    mask: Texture,
    colors: TerrainStyleColors,
    thresholds: TerrainStyleThresholds,
    params?: Partial<TerrainStyleParams>,
  ): void {
    this.mask = mask;
    this.colors = colors;
    this.thresholds = thresholds;
    this.params = { ...this.params, ...params };
    this._enable(true);
    this.markAllDefinesAsDirty();
  }

  public override getClassName(): string {
    return "TerrainStylePlugin";
  }

  public override prepareDefines(defines: MaterialDefines): void {
    defines["TERRAIN_STYLE"] = this.mask !== null;
  }

  public override isReadyForSubMesh(): boolean {
    return this.mask?.isReady() ?? true;
  }

  public override getSamplers(samplers: string[]): void {
    samplers.push(MASK_SAMPLER);
  }

  public override getUniforms(): { ubo: Array<{ name: string; size: number; type: string }>; fragment: string } {
    const uniformNames = [...COLOR_UNIFORMS.map(([, name]) => name), "terrainStyleThresholds", "terrainStyleParams"];
    return {
      ubo: uniformNames.map((name) => ({ name, size: 4, type: "vec4" })),
      fragment: `
#ifdef TERRAIN_STYLE
${uniformNames.map((name) => `uniform vec4 ${name};`).join("\n")}
#endif
`,
    };
  }

  public override bindForSubMesh(uniformBuffer: UniformBuffer): void {
    if (!this.mask || !this.colors) {
      return;
    }
    for (const [key, name] of COLOR_UNIFORMS) {
      const color = this.colors[key];
      uniformBuffer.updateFloat4(name, color.r, color.g, color.b, 1);
    }
    uniformBuffer.updateFloat4(
      "terrainStyleThresholds",
      this.thresholds.fairway,
      this.thresholds.green,
      this.thresholds.bunker,
      this.thresholds.fringe,
    );
    uniformBuffer.updateFloat4(
      "terrainStyleParams",
      this.params.firstCutWeight,
      this.params.greenCheckerWidthM,
      this.params.greenCheckerContrast,
      this.params.minEdgeSoftness,
    );
    uniformBuffer.setTexture(MASK_SAMPLER, this.mask);
  }

  public override hasTexture(texture: BaseTexture): boolean {
    return this.mask === texture;
  }

  public override getActiveTextures(activeTextures: BaseTexture[]): void {
    if (this.mask) {
      activeTextures.push(this.mask);
    }
  }

  public override dispose(forceDisposeTextures?: boolean): void {
    if (forceDisposeTextures) {
      this.mask?.dispose();
    }
    this.mask = null;
    this.colors = null;
  }

  public override getCustomCode(shaderType: string): Nullable<{ [pointName: string]: string }> {
    if (shaderType !== "fragment") {
      return null;
    }
    return {
      CUSTOM_FRAGMENT_DEFINITIONS: fragmentDefinitions,
      CUSTOM_FRAGMENT_UPDATE_DIFFUSE: fragmentUpdateDiffuse,
    };
  }
}
