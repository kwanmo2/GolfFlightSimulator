import {
  Color3,
  LinesMesh,
  Mesh,
  MeshBuilder,
  Scene,
  StandardMaterial,
  Vector3,
} from "@babylonjs/core";
import type { Vec3 } from "../core/vector";
import type { TrajectoryDisplayMode, TrajectorySegments } from "../types/simulation";
import type { GroundHeightResolver } from "./ballRenderer";
import { PALETTE, toColor3 } from "./palette";

export interface RenderedTrajectory {
  points: Vec3[];
  landingPoint: Vec3 | null;
  segments: TrajectorySegments;
}

export interface TrajectoryRenderer {
  setTrajectories(options: {
    current: RenderedTrajectory | null;
    comparison: RenderedTrajectory | null;
    mode: TrajectoryDisplayMode;
  }): void;
  highlightFrame(point: Vec3): void;
}

/** Simulated points are already in world space; only a small lift against z-fighting is added. */
const toBabylonPoints = (points: Vec3[], yOffset = 0): Vector3[] =>
  points.map((point) => new Vector3(point.x, point.y + yOffset, point.z));

/** The flight path projected straight down onto the terrain. */
const toGroundPoints = (
  points: Vec3[],
  groundHeightAt: GroundHeightResolver,
  yOffset: number,
): Vector3[] =>
  points.map((point) => new Vector3(point.x, groundHeightAt(point.x, point.z) + yOffset, point.z));

const createLandingStack = (
  scene: Scene,
  prefix: string,
  color: Color3,
): {
  marker: Mesh;
  pulse: Mesh;
  beacon: Mesh;
} => {
  const marker = MeshBuilder.CreateTorus(
    `${prefix}-landing-marker`,
    {
      diameter: 2.6,
      thickness: 0.12,
      tessellation: 48,
    },
    scene,
  );
  marker.rotation.x = Math.PI / 2;
  marker.position.y = 0.05;

  const pulse = MeshBuilder.CreateDisc(
    `${prefix}-landing-pulse`,
    {
      radius: 1.9,
      tessellation: 48,
    },
    scene,
  );
  pulse.rotation.x = Math.PI / 2;
  pulse.position.y = 0.03;

  const beacon = MeshBuilder.CreateCylinder(
    `${prefix}-landing-beacon`,
    {
      diameterTop: 0.06,
      diameterBottom: 0.18,
      height: 3.5,
      tessellation: 24,
    },
    scene,
  );
  beacon.position.y = 1.75;

  const markerMaterial = new StandardMaterial(`${prefix}-landing-marker-material`, scene);
  markerMaterial.emissiveColor = color;
  markerMaterial.diffuseColor = color.scale(0.92);
  marker.material = markerMaterial;

  const pulseMaterial = new StandardMaterial(`${prefix}-landing-pulse-material`, scene);
  pulseMaterial.emissiveColor = color.scale(1.08);
  pulseMaterial.diffuseColor = color;
  pulseMaterial.alpha = prefix === "comparison" ? 0.17 : 0.24;
  pulse.material = pulseMaterial;

  const beaconMaterial = new StandardMaterial(`${prefix}-landing-beacon-material`, scene);
  beaconMaterial.emissiveColor = color.scale(1.04);
  beaconMaterial.diffuseColor = color;
  beaconMaterial.alpha = prefix === "comparison" ? 0.48 : 0.72;
  beacon.material = beaconMaterial;

  marker.isVisible = false;
  pulse.isVisible = false;
  beacon.isVisible = false;

  return { marker, pulse, beacon };
};

const sliceTrajectory = (
  trajectory: RenderedTrajectory,
  mode: TrajectoryDisplayMode,
): Vec3[] => {
  switch (mode) {
    case "carry_only":
      return trajectory.points.slice(0, Math.max(trajectory.segments.carryEndIndex + 1, 2));
    case "roll_only":
      return trajectory.points.slice(
        Math.min(trajectory.segments.carryEndIndex, trajectory.points.length - 1),
      );
    default:
      return trajectory.points;
  }
};

export const createTrajectoryRenderer = (
  scene: Scene,
  groundHeightAt: GroundHeightResolver,
): TrajectoryRenderer => {
  let currentLine: LinesMesh | null = null;
  let currentShadow: LinesMesh | null = null;
  let comparisonLine: LinesMesh | null = null;

  const currentLanding = createLandingStack(scene, "current", toColor3(PALETTE.trajectory.landing));
  const comparisonLanding = createLandingStack(
    scene,
    "comparison",
    toColor3(PALETTE.trajectory.comparisonLanding),
  );

  const liveMarker = MeshBuilder.CreateSphere(
    "trajectory-live-marker",
    {
      diameter: 0.22,
      segments: 14,
    },
    scene,
  );
  const liveMaterial = new StandardMaterial("live-marker-material", scene);
  liveMaterial.emissiveColor = toColor3(PALETTE.trajectory.liveMarker);
  liveMaterial.diffuseColor = Color3.White();
  liveMarker.material = liveMaterial;
  liveMarker.isVisible = false;

  scene.onBeforeRenderObservable.add(() => {
    const t = performance.now() * 0.0022;
    [currentLanding, comparisonLanding].forEach((landing, index) => {
      landing.marker.rotation.z += 0.008 + index * 0.003;
      landing.pulse.scaling.x = 1 + Math.sin(t + index * 0.6) * 0.12;
      landing.pulse.scaling.y = 1 + Math.sin(t + index * 0.6) * 0.12;
      landing.pulse.visibility = 0.68 + Math.sin(t * 1.4 + index) * 0.18;
      landing.beacon.visibility = 0.74 + Math.sin(t * 1.1 + index) * 0.14;
    });
  });

  return {
    setTrajectories({ current, comparison, mode }) {
      currentLine?.dispose();
      currentShadow?.dispose();
      comparisonLine?.dispose();

      const currentPoints = current ? sliceTrajectory(current, mode) : [];
      if (currentPoints.length > 1) {
        currentLine = MeshBuilder.CreateLines(
          "trajectory-line",
          {
            points: toBabylonPoints(currentPoints, 0.04),
          },
          scene,
        );
        currentLine.color = toColor3(PALETTE.trajectory.current);
        currentLine.alpha = 0.95;

        currentShadow = MeshBuilder.CreateLines(
          "trajectory-shadow-line",
          {
            points: toGroundPoints(currentPoints, groundHeightAt, 0.03),
          },
          scene,
        );
        currentShadow.color = toColor3(PALETTE.trajectory.currentShadow);
        currentShadow.alpha = 0.5;
      }

      const showComparison = mode === "comparison" && comparison && comparison.points.length > 1;
      if (showComparison) {
        comparisonLine = MeshBuilder.CreateLines(
          "comparison-trajectory-line",
          {
            points: toBabylonPoints(comparison.points, 0.06),
          },
          scene,
        );
        comparisonLine.color = toColor3(PALETTE.trajectory.comparison);
        comparisonLine.alpha = 0.78;
      }

      const updateLanding = (
        landing: typeof currentLanding,
        point: Vec3 | null,
        visible: boolean,
      ) => {
        landing.marker.isVisible = visible && point !== null;
        landing.pulse.isVisible = visible && point !== null;
        landing.beacon.isVisible = visible && point !== null;
        if (point) {
          const groundY = groundHeightAt(point.x, point.z);
          landing.marker.position.copyFromFloats(point.x, groundY + 0.05, point.z);
          landing.pulse.position.copyFromFloats(point.x, groundY + 0.03, point.z);
          landing.beacon.position.copyFromFloats(point.x, groundY + 1.75, point.z);
        }
      };

      updateLanding(currentLanding, current?.landingPoint ?? null, true);
      updateLanding(comparisonLanding, comparison?.landingPoint ?? null, Boolean(showComparison));
    },
    highlightFrame(point) {
      liveMarker.isVisible = true;
      liveMarker.position.copyFromFloats(point.x, point.y, point.z);
    },
  };
};

