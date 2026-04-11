import {
  AbstractMesh,
  ArcRotateCamera,
  Color3,
  Color4,
  DirectionalLight,
  Engine,
  FollowCamera,
  HemisphericLight,
  Mesh,
  MeshBuilder,
  Scene,
  ShadowGenerator,
  Vector3,
} from "@babylonjs/core";
import { createFieldMaterials } from "./materials";
import { populateFieldProps } from "./props";
import { createFieldModel, createTerrainMesh } from "./terrain";
import type {
  ReplayCameraMode,
  ShotAnalysisMetrics,
  SimulationFrame,
  SurfaceType,
} from "../types/simulation";

export interface SceneController {
  engine: Engine;
  scene: Scene;
  setActiveCamera(cameraName: ReplayCameraMode): void;
  attachFollowTarget(target: AbstractMesh): void;
  updateReplayCamera(
    frame: SimulationFrame,
    metrics: ShotAnalysisMetrics,
    cameraMode: ReplayCameraMode,
  ): void;
  getSurfaceTypeAt(x: number, z: number): SurfaceType;
  resize(): void;
}

const lerpVector = (from: Vector3, to: Vector3, alpha: number): Vector3 =>
  new Vector3(
    from.x + (to.x - from.x) * alpha,
    from.y + (to.y - from.y) * alpha,
    from.z + (to.z - from.z) * alpha,
  );

export const createSceneController = (canvas: HTMLCanvasElement): SceneController => {
  const engine = new Engine(canvas, true, {
    preserveDrawingBuffer: true,
    stencil: true,
  });
  const scene = new Scene(engine);
  scene.clearColor = new Color4(0.8, 0.9, 1, 1);
  scene.fogMode = Scene.FOGMODE_EXP2;
  scene.fogDensity = 0.00135;
  scene.fogColor = new Color3(0.84, 0.91, 0.98);

  const field = createFieldModel();
  const materials = createFieldMaterials(scene, field);
  const terrain = createTerrainMesh(scene, field);
  terrain.material = materials.terrain;
  terrain.receiveShadows = true;

  const skyDome = MeshBuilder.CreateSphere(
    "sky-dome",
    {
      diameter: 1400,
      segments: 24,
      sideOrientation: Mesh.BACKSIDE,
    },
    scene,
  );
  skyDome.material = materials.sky;
  skyDome.isPickable = false;

  const hemiLight = new HemisphericLight(
    "hemi-light",
    new Vector3(-0.12, 1, -0.08),
    scene,
  );
  hemiLight.intensity = 0.55;
  hemiLight.groundColor = new Color3(0.31, 0.35, 0.24);

  const sun = new DirectionalLight(
    "sun-light",
    new Vector3(-0.48, -1, 0.14),
    scene,
  );
  sun.intensity = 1.32;
  sun.position = new Vector3(92, 130, -46);

  const shadowGenerator = new ShadowGenerator(1024, sun);
  shadowGenerator.useBlurExponentialShadowMap = true;
  shadowGenerator.blurKernel = 12;

  populateFieldProps(scene, field, materials);

  const chaseAnchor = new Mesh("chase-anchor", scene);
  chaseAnchor.isVisible = false;
  const broadcastTarget = new Mesh("broadcast-target", scene);
  broadcastTarget.isVisible = false;
  const dispersionTarget = new Mesh("dispersion-target", scene);
  dispersionTarget.isVisible = false;

  const chaseCamera = new FollowCamera(
    "chase-camera",
    new Vector3(0, 7, -16),
    scene,
  );
  chaseCamera.lockedTarget = chaseAnchor;
  chaseCamera.radius = 18;
  chaseCamera.heightOffset = 6.2;
  chaseCamera.rotationOffset = 180;
  chaseCamera.cameraAcceleration = 0.03;
  chaseCamera.maxCameraSpeed = 20;

  const broadcastCamera = new ArcRotateCamera(
    "broadcast-camera",
    -Math.PI / 2.35,
    1.08,
    88,
    new Vector3(0, 16, 140),
    scene,
  );
  broadcastCamera.lowerRadiusLimit = 28;
  broadcastCamera.upperRadiusLimit = 220;

  const dispersionCamera = new ArcRotateCamera(
    "dispersion-camera",
    -Math.PI / 2,
    0.42,
    190,
    new Vector3(0, 12, 160),
    scene,
  );
  dispersionCamera.lowerRadiusLimit = 70;
  dispersionCamera.upperRadiusLimit = 280;

  scene.activeCamera = broadcastCamera;
  scene.activeCamera.attachControl(canvas, true);

  return {
    engine,
    scene,
    setActiveCamera(cameraName) {
      scene.activeCamera =
        cameraName === "chase"
          ? chaseCamera
          : cameraName === "dispersion"
            ? dispersionCamera
            : broadcastCamera;
      scene.activeCamera.attachControl(canvas, cameraName !== "chase");
    },
    attachFollowTarget(target) {
      chaseAnchor.position.copyFrom(target.position);
      shadowGenerator.addShadowCaster(target, false);
    },
    updateReplayCamera(frame, metrics, cameraMode) {
      const ballPosition = new Vector3(frame.position.x, frame.position.y, frame.position.z);
      const velocity = new Vector3(frame.velocity.x, frame.velocity.y, frame.velocity.z);
      const direction =
        velocity.lengthSquared() > 0.0001 ? velocity.normalize() : new Vector3(0, 0, 1);

      const chaseFocus = ballPosition.add(
        new Vector3(0, 1.05 + Math.min(ballPosition.y * 0.08, 3.2), 0),
      );
      chaseAnchor.position.copyFrom(lerpVector(chaseAnchor.position, chaseFocus, 0.12));
      chaseCamera.heightOffset = 5.6 + Math.min(ballPosition.y * 0.14, 10);
      chaseCamera.radius = 15 + Math.min(ballPosition.y * 0.12, 16);
      chaseCamera.rotationOffset =
        (Math.atan2(direction.x, direction.z) * 180) / Math.PI + 180;
      chaseCamera.cameraAcceleration = cameraMode === "broadcast" ? 0.022 : 0.034;
      chaseCamera.maxCameraSpeed = cameraMode === "broadcast" ? 16 : 24;

      const landingPoint = metrics.landingPoint
        ? new Vector3(metrics.landingPoint.x, 0, metrics.landingPoint.z)
        : new Vector3(frame.position.x, 0, frame.position.z + 22);
      const broadcastLook = new Vector3(
        ballPosition.x * 0.25 + landingPoint.x * 0.75,
        Math.max(6, ballPosition.y * 0.25 + 7),
        Math.max(ballPosition.z + 18, landingPoint.z * 0.82),
      );
      broadcastTarget.position.copyFrom(
        lerpVector(broadcastTarget.position, broadcastLook, 0.06),
      );
      broadcastCamera.setTarget(broadcastTarget.position);
      broadcastCamera.radius = 54 + Math.min(ballPosition.y * 0.5, 72);
      broadcastCamera.alpha = -Math.PI / 2.34 + Math.sin(frame.time * 0.32) * 0.07;
      broadcastCamera.beta = 1.05 - Math.min(ballPosition.y / 240, 0.16);

      const midZ = Math.max(120, Math.min(field.holeLengthM - 24, (ballPosition.z + landingPoint.z) * 0.5));
      const dispersionLook = new Vector3(
        landingPoint.x * 0.55 + ballPosition.x * 0.45,
        4,
        midZ,
      );
      dispersionTarget.position.copyFrom(
        lerpVector(dispersionTarget.position, dispersionLook, 0.09),
      );
      dispersionCamera.setTarget(dispersionTarget.position);
      dispersionCamera.radius = 118 + Math.max(0, landingPoint.z - ballPosition.z) * 0.18;
      dispersionCamera.alpha = -Math.PI / 2;
      dispersionCamera.beta = 0.36;
    },
    getSurfaceTypeAt(x, z) {
      return field.getSurfaceType(x, z);
    },
    resize() {
      engine.resize();
    },
  };
};

