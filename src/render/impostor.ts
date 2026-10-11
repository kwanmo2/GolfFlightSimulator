import {
  Color4,
  Constants,
  FreeCamera,
  Material,
  MaterialDefines,
  MaterialPluginBase,
  Mesh,
  MultiMaterial,
  PBRMaterial,
  RawTexture,
  RenderTargetTexture,
  StandardMaterial,
  Texture,
  UniformBuffer,
  Vector3,
  VertexData,
} from "@babylonjs/core";
import type { Nullable, Scene } from "@babylonjs/core";
import type { GeneratedTree } from "./treeGenerator";

/**
 * Far-away trees drawn as impostors: each tree is photographed from a ring of
 * directions once at load time, and distant copies are quads that always face
 * the camera and show the photo taken from the matching side. A forest of
 * thousands then costs a handful of draw calls.
 */

/** Views around the tree, laid out as FRAME_COLUMNS x FRAME_ROWS in the atlas. */
const FRAME_COLUMNS = 4;
const FRAME_ROWS = 2;
const FRAME_COUNT = FRAME_COLUMNS * FRAME_ROWS;
const FRAME_SIZE_PX = 256;
/** Layer reserved for bake-only meshes, so the scene cameras never draw them. */
const BAKE_LAYER = 0x10000000;
const ALPHA_CUTOFF = 0.42;
const IMPOSTOR_ROUGHNESS = 0.85;
/**
 * Brightness match against the full trees: the bake has no crown occlusion
 * (an unlit StandardMaterial drops vertex colours with its diffuse term), so
 * the impostors are darkened by the full trees' average occlusion instead.
 */
const IMPOSTOR_BRIGHTNESS = 0.75;
/** Leaves reflect less than the default dielectric F0; see vegetation.ts. */
const IMPOSTOR_F0_FACTOR = 0.35;

export interface ImpostorTemplate {
  /** Camera-facing quad (1 x 1, origin at its bottom centre) to thin-instance. */
  mesh: Mesh;
  /** World width and height of the quad at scale 1, metres. */
  widthM: number;
  heightM: number;
}

const vertexDefinitions = `
#ifdef TREE_IMPOSTOR
varying vec2 vImpostorLocal;
varying vec3 vImpostorRight;
varying vec3 vImpostorForward;
#endif
`;

// Billboard around the vertical axis and pick the atlas frame photographed
// from the side the camera is on. Frame f was baked from azimuth f * 2pi / N
// in the tree's own frame; the instance's yaw is read back from finalWorld.
const vertexUpdateWorldPos = `
#ifdef TREE_IMPOSTOR
vec3 impostorCenter = finalWorld[3].xyz;
float impostorWidth = length(finalWorld[0].xyz);
float impostorHeight = length(finalWorld[1].xyz);
vec2 impostorToEye = vEyePosition.xz - impostorCenter.xz;
impostorToEye = impostorToEye / max(length(impostorToEye), 0.0001);
vec3 impostorRight = vec3(-impostorToEye.y, 0.0, impostorToEye.x);
worldPos = vec4(impostorCenter + impostorRight * positionUpdated.x * impostorWidth + vec3(0.0, positionUpdated.y * impostorHeight, 0.0), 1.0);
vPositionW = worldPos.xyz;
vNormalW = vec3(impostorToEye.x, 0.0, impostorToEye.y);
float impostorYaw = atan(-finalWorld[0].z, finalWorld[0].x);
float impostorAzimuth = atan(impostorToEye.y, impostorToEye.x) + impostorYaw;
float impostorFrame = mod(floor(impostorAzimuth / 6.2831853 * impostorFrames.z + 0.5), impostorFrames.z);
#ifdef UV1
uvUpdated = (vec2(mod(impostorFrame, impostorFrames.x), floor(impostorFrame / impostorFrames.x)) + uvUpdated) / impostorFrames.xy;
#endif
vImpostorLocal = positionUpdated.xy;
vImpostorRight = impostorRight;
vImpostorForward = vec3(impostorToEye.x, 0.0, impostorToEye.y);
#endif
`;

const fragmentDefinitions = `
#ifdef TREE_IMPOSTOR
varying vec2 vImpostorLocal;
varying vec3 vImpostorRight;
varying vec3 vImpostorForward;
#endif
`;

// The photo has no normals, so the crown is lit as a rough ellipsoid seen from
// the front: the same volume shading the full trees get from their bent card
// normals, which keeps near and far trees matching.
const fragmentUpdateAlbedo = `
#ifdef TREE_IMPOSTOR
vec2 impostorCrown = vec2(vImpostorLocal.x * 2.0, (vImpostorLocal.y - 0.58) * 2.2);
float impostorFront = sqrt(max(0.08, 1.0 - dot(impostorCrown, impostorCrown)));
normalW = normalize(vImpostorRight * impostorCrown.x + vec3(0.0, impostorCrown.y * 0.8 + 0.3, 0.0) + vImpostorForward * impostorFront);
surfaceAlbedo *= impostorFrames.w;
#endif
`;

class ImpostorPlugin extends MaterialPluginBase {
  public constructor(material: PBRMaterial) {
    super(material, "TreeImpostor", 200, { TREE_IMPOSTOR: false });
    this._enable(true);
  }

  public override getClassName(): string {
    return "ImpostorPlugin";
  }

  public override prepareDefines(defines: MaterialDefines): void {
    defines["TREE_IMPOSTOR"] = true;
  }

  public override getUniforms(): {
    ubo: Array<{ name: string; size: number; type: string }>;
    vertex: string;
    fragment: string;
  } {
    return {
      ubo: [{ name: "impostorFrames", size: 4, type: "vec4" }],
      vertex: `
#ifdef TREE_IMPOSTOR
uniform vec4 impostorFrames;
#endif
`,
      fragment: `
#ifdef TREE_IMPOSTOR
uniform vec4 impostorFrames;
#endif
`,
    };
  }

  public override bindForSubMesh(uniformBuffer: UniformBuffer): void {
    uniformBuffer.updateFloat4("impostorFrames", FRAME_COLUMNS, FRAME_ROWS, FRAME_COUNT, IMPOSTOR_BRIGHTNESS);
  }

  public override getCustomCode(shaderType: string): Nullable<{ [pointName: string]: string }> {
    if (shaderType === "vertex") {
      return { CUSTOM_VERTEX_DEFINITIONS: vertexDefinitions, CUSTOM_VERTEX_UPDATE_WORLDPOS: vertexUpdateWorldPos };
    }
    return { CUSTOM_FRAGMENT_DEFINITIONS: fragmentDefinitions, CUSTOM_FRAGMENT_UPDATE_ALPHA: fragmentUpdateAlbedo };
  }
}

/** Unlit stand-in for a PBR material, so the photo holds albedo only. */
const createBakeMaterial = (scene: Scene, source: Material): StandardMaterial => {
  const bake = new StandardMaterial(`${source.name}-bake`, scene);
  bake.disableLighting = true;
  bake.fogEnabled = false;
  bake.backFaceCulling = false;
  // With lighting disabled a StandardMaterial outputs only its emissive term,
  // so the albedo goes in as the emissive texture: the photo holds the sRGB
  // albedo. The diffuse texture stays bound for its alpha.
  bake.diffuseColor.set(0, 0, 0);
  bake.specularColor.set(0, 0, 0);
  if (source instanceof PBRMaterial) {
    bake.emissiveTexture = source.albedoTexture;
    bake.emissiveColor = source.albedoColor.toGammaSpace();
    bake.diffuseTexture = source.albedoTexture;
    if (source.albedoTexture?.hasAlpha) {
      bake.useAlphaFromDiffuseTexture = true;
      bake.transparencyMode = Material.MATERIAL_ALPHATEST;
      bake.alphaCutOff = ALPHA_CUTOFF;
    }
  }
  return bake;
};

const waitUntilReady = (target: RenderTargetTexture): Promise<void> =>
  new Promise((resolve) => {
    const check = (): void => {
      if (target.isReadyForRendering()) {
        resolve();
      } else {
        setTimeout(check, 30);
      }
    };
    check();
  });

/** Copy one frame (rows bottom-up, as readPixels returns them) into the atlas. */
const blitFrame = (atlas: Uint8Array, atlasWidth: number, frame: Uint8Array, column: number, row: number): void => {
  const rowBytes = FRAME_SIZE_PX * 4;
  for (let y = 0; y < FRAME_SIZE_PX; y += 1) {
    const target = ((row * FRAME_SIZE_PX + y) * atlasWidth + column * FRAME_SIZE_PX) * 4;
    atlas.set(frame.subarray(y * rowBytes, (y + 1) * rowBytes), target);
  }
};

/**
 * Photograph `tree` from FRAME_COUNT directions and return a quad template
 * whose material shows the matching view. `background` is the colour the
 * transparent pixels take, so mipmaps fade to foliage rather than black.
 */
export const bakeImpostor = async (
  scene: Scene,
  name: string,
  tree: GeneratedTree,
  background: [number, number, number],
): Promise<ImpostorTemplate> => {
  const source = tree.mesh;
  const bakeMesh = source.clone(`${name}-bake-mesh`, null, true, false);
  if (!bakeMesh) {
    throw new Error(`Could not clone ${source.name} for its impostor bake.`);
  }
  const sourceMaterials = source.material instanceof MultiMaterial ? source.material.subMaterials : [source.material];
  const bakeMaterials = new MultiMaterial(`${name}-bake-materials`, scene);
  sourceMaterials.forEach((material) => {
    if (material) {
      bakeMaterials.subMaterials.push(createBakeMaterial(scene, material));
    }
  });
  bakeMesh.material = bakeMaterials;
  bakeMesh.layerMask = BAKE_LAYER;
  bakeMesh.isVisible = true;
  bakeMesh.setEnabled(true);

  const widthM = tree.radiusM * 2.1;
  const heightM = tree.heightM * 1.04;
  const camera = new FreeCamera(`${name}-bake-camera`, Vector3.Zero(), scene, false);
  camera.mode = FreeCamera.ORTHOGRAPHIC_CAMERA;
  camera.orthoLeft = -widthM / 2;
  camera.orthoRight = widthM / 2;
  camera.orthoBottom = 0;
  camera.orthoTop = heightM;
  camera.minZ = 0.1;
  camera.maxZ = tree.radiusM * 4 + 10;
  camera.layerMask = BAKE_LAYER;

  const target = new RenderTargetTexture(`${name}-bake-target`, FRAME_SIZE_PX, scene, { generateMipMaps: false });
  target.renderList = [bakeMesh];
  target.activeCamera = camera;
  target.clearColor = new Color4(background[0], background[1], background[2], 0);
  target.renderParticles = false;
  target.renderSprites = false;
  target.skipInitialClear = false;

  const atlasWidth = FRAME_COLUMNS * FRAME_SIZE_PX;
  const atlasHeight = FRAME_ROWS * FRAME_SIZE_PX;
  const atlas = new Uint8Array(atlasWidth * atlasHeight * 4);
  try {
    await waitUntilReady(target);
    const distance = tree.radiusM * 2 + 5;
    for (let frame = 0; frame < FRAME_COUNT; frame += 1) {
      const azimuth = (frame / FRAME_COUNT) * Math.PI * 2;
      // Level camera, centred on the trunk, looking back at it.
      camera.position.set(Math.cos(azimuth) * distance, 0, Math.sin(azimuth) * distance);
      camera.setTarget(new Vector3(0, 0, 0));
      target.render();
      const pixels = await target.readPixels();
      if (!pixels) {
        throw new Error(`Impostor bake for ${name} returned no pixels.`);
      }
      blitFrame(atlas, atlasWidth, new Uint8Array(pixels.buffer, pixels.byteOffset, pixels.byteLength), frame % FRAME_COLUMNS, Math.floor(frame / FRAME_COLUMNS));
    }
  } finally {
    target.dispose();
    camera.dispose();
    bakeMesh.dispose();
    bakeMaterials.subMaterials.forEach((material) => material?.dispose());
    bakeMaterials.dispose();
  }

  const texture = RawTexture.CreateRGBATexture(atlas, atlasWidth, atlasHeight, scene, true, false, Constants.TEXTURE_TRILINEAR_SAMPLINGMODE);
  texture.name = `${name}-impostor-atlas`;
  texture.hasAlpha = true;
  texture.wrapU = Texture.CLAMP_ADDRESSMODE;
  texture.wrapV = Texture.CLAMP_ADDRESSMODE;

  const material = new PBRMaterial(`${name}-impostor-material`, scene);
  material.albedoTexture = texture;
  material.useAlphaFromAlbedoTexture = true;
  material.transparencyMode = PBRMaterial.PBRMATERIAL_ALPHATEST;
  material.alphaCutOff = ALPHA_CUTOFF;
  material.metallic = 0;
  material.roughness = IMPOSTOR_ROUGHNESS;
  material.metallicF0Factor = IMPOSTOR_F0_FACTOR;
  material.backFaceCulling = false;
  new ImpostorPlugin(material);

  const mesh = new Mesh(`${name}-impostor`, scene);
  const quad = new VertexData();
  quad.positions = [-0.5, 0, 0, 0.5, 0, 0, -0.5, 1, 0, 0.5, 1, 0];
  quad.normals = [0, 0, -1, 0, 0, -1, 0, 0, -1, 0, 0, -1];
  quad.uvs = [0, 0, 1, 0, 0, 1, 1, 1];
  quad.indices = [0, 2, 1, 1, 2, 3];
  quad.applyToMesh(mesh);
  mesh.material = material;
  mesh.isPickable = false;
  // The vertex shader moves the quad; culling against the unmoved quad would drop visible trees.
  mesh.alwaysSelectAsActiveMesh = true;
  return { mesh, widthM, heightM };
};
