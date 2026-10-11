import { MaterialDefines, MaterialPluginBase, UniformBuffer } from "@babylonjs/core";
import type { Material, Nullable } from "@babylonjs/core";
import { WIND } from "./renderConfig";

export interface WindResponse {
  /** Peak sideways sway at referenceHeightM, metres. */
  swayM: number;
  /** Fast leaf or blade flutter, metres. */
  flutterM: number;
  /** Height above the plant's base where sway reaches swayM. */
  referenceHeightM: number;
}

const vertexDefinitions = `
#ifdef WIND_SWAY
uniform vec4 windResponse;
uniform vec4 windState;
#endif
`;

// Applied after the world position is known, so the instance's own base
// (finalWorld's translation) gives each plant its own phase and its height
// above the ground. Sway grows with the square of height, like a cantilever.
const vertexUpdateWorldPos = `
#ifdef WIND_SWAY
vec3 windBase = finalWorld[3].xyz;
float windHeight = max(0.0, worldPos.y - windBase.y) / windResponse.z;
float windPhase = dot(windBase.xz, vec2(0.071, 0.113));
float windTime = windState.w;
float windGust = 0.65 + 0.35 * sin(windTime * 0.37 + windPhase * 0.5);
float windSway = (sin(windTime * 1.05 + windPhase) * 0.7 + sin(windTime * 2.3 + windPhase * 1.9) * 0.3) * windGust;
worldPos.xz += windState.xy * windSway * windResponse.x * windHeight * windHeight;
float windFlutter = sin(windTime * 7.0 + dot(worldPos.xyz, vec3(1.7, 2.3, 1.3)));
worldPos.xyz += vec3(0.6, 0.3, 0.6) * windFlutter * windResponse.y * min(windHeight, 1.0) * windGust;
vPositionW = worldPos.xyz;
#endif
`;

/**
 * Sways a plant in the wind. Shadow maps are rendered without the sway, which
 * is invisible at these amplitudes.
 */
export class WindPlugin extends MaterialPluginBase {
  public constructor(material: Material, private readonly response: WindResponse) {
    super(material, "Wind", 150, { WIND_SWAY: false });
    this._enable(true);
  }

  public override getClassName(): string {
    return "WindPlugin";
  }

  public override prepareDefines(defines: MaterialDefines): void {
    defines["WIND_SWAY"] = true;
  }

  public override getUniforms(): { ubo: Array<{ name: string; size: number; type: string }>; vertex: string } {
    return {
      ubo: [
        { name: "windResponse", size: 4, type: "vec4" },
        { name: "windState", size: 4, type: "vec4" },
      ],
      vertex: vertexDefinitions,
    };
  }

  public override bindForSubMesh(uniformBuffer: UniformBuffer): void {
    const timeS = performance.now() * 0.001;
    uniformBuffer.updateFloat4("windResponse", this.response.swayM, this.response.flutterM, this.response.referenceHeightM, 0);
    uniformBuffer.updateFloat4("windState", WIND.directionX, WIND.directionZ, 0, timeS);
  }

  public override getCustomCode(shaderType: string): Nullable<{ [pointName: string]: string }> {
    if (shaderType !== "vertex") {
      return null;
    }
    return { CUSTOM_VERTEX_UPDATE_WORLDPOS: vertexUpdateWorldPos };
  }
}
