import type { PhysicsConfig } from "../core/physicsConfig";
import type { Vec3 } from "../core/vector";

export type MotionPhase = "flight" | "skid" | "roll" | "rest";
export type ReplayCameraMode = "broadcast" | "chase" | "dispersion";
/** Render quality: "high" adds screen-space ambient occlusion on top of "standard". */
export type GraphicsQuality = "high" | "standard";
export type TrajectoryDisplayMode =
  | "full"
  | "carry_only"
  | "roll_only"
  | "comparison";
export type ComparisonTarget = "none" | "previous" | "baseline";
export type SurfaceType = "tee" | "fairway" | "rough" | "green" | "bunker" | "fringe" | "water";
export type GroundCondition = "normal" | "dry" | "wet";
export type CalibrationProfileId =
  | "driver"
  | "long_iron"
  | "short_iron"
  | "wedge"
  | "putt_like";
export type ProfileSelection = "input_default" | CalibrationProfileId;

export interface EnvironmentState {
  windSpeedMps: number;
  windDirectionRad: number;
  windVector: Vec3;
  altitudeM: number;
  airDensityKgPerM3: number;
  groundCondition: GroundCondition;
}

export interface CalibrationProfile {
  id: CalibrationProfileId;
  label: string;
  description: string;
  aerodynamicMultiplier: {
    drag: number;
    backSpinLift: number;
    sideSpinCurve: number;
    backSpinDecay: number;
    sideSpinDecay: number;
  };
  groundMultiplier: {
    restitution: number;
    skidDamping: number;
    skidFriction: number;
    rollFriction: number;
  };
}

export interface InitialConditions {
  position: Vec3;
  velocity: Vec3;
  spin: Vec3;
}

export interface SimulationState extends InitialConditions {
  time: number;
  phase: MotionPhase;
  bounceCount: number;
  surface: SurfaceType;
}

export interface SimulationFrame {
  time: number;
  position: Vec3;
  velocity: Vec3;
  spin: Vec3;
  phase: MotionPhase;
  surface: SurfaceType;
}

export interface ShotAnalysisMetrics {
  ballSpeedMps: number;
  launchAngleDeg: number;
  launchDirectionDeg: number;
  spinRpm: number;
  carryDistanceM: number;
  totalDistanceM: number;
  apexHeightM: number;
  flightTimeS: number;
  hangTimeS: number;
  lateralDeviationM: number;
  landingAngleDeg: number;
  descentAngleDeg: number;
  landingPoint: Vec3 | null;
  landingSurface: SurfaceType | null;
  profileId: CalibrationProfileId;
  recommendedProfileId: CalibrationProfileId;
}

export interface TrajectorySegments {
  carryEndIndex: number;
  rollStartIndex: number | null;
}

export interface ShotSessionEntry {
  shotName: string;
  recordedAtIso: string;
  metrics: ShotAnalysisMetrics;
}

export interface ShotSession {
  id: string;
  title: string;
  entries: ShotSessionEntry[];
}

export interface SavedReplay {
  shotName: string;
  cameraMode: ReplayCameraMode;
  trajectoryMode: TrajectoryDisplayMode;
  capturedAtIso: string;
}

export interface ComparisonPair {
  currentShotName: string;
  referenceShotName: string;
}

export interface SimulationResult {
  config: PhysicsConfig;
  environment: EnvironmentState;
  profile: CalibrationProfile;
  frames: SimulationFrame[];
  metrics: ShotAnalysisMetrics;
  segments: TrajectorySegments;
}
