import type {
  CalibrationProfileId,
  GroundCondition,
  SurfaceType,
} from "./simulation";

export type SpeedUnit = "mph" | "mps" | "kph";
export type AngleUnit = "deg" | "rad";
export type SpinUnit = "rpm" | "radps";

export interface ShotUnits {
  speed: SpeedUnit;
  angle: AngleUnit;
  spin: SpinUnit;
}

export interface ShotEnvironmentInput {
  windSpeed?: number;
  windDirection?: number;
  altitude?: number;
  airDensity?: number;
  groundCondition?: GroundCondition;
}

export interface ShotInput {
  name?: string;
  description?: string;
  ballSpeed: number;
  launchAngle: number;
  launchDirection: number;
  backSpin?: number;
  sideSpin?: number;
  totalSpin?: number;
  spinAxis?: number;
  clubPath?: number;
  faceAngle?: number;
  attackAngle?: number;
  dynamicLoft?: number;
  clubHeadSpeed?: number;
  impactPointHV?: number;
  lowPoint?: number;
  swingPlane?: number;
  swingDirection?: number;
  clubLie?: number;
  closureRate?: number;
  faceToAxis?: number;
  clubType?: CalibrationProfileId;
  environment?: ShotEnvironmentInput;
  surfaceOverride?: SurfaceType;
  units?: Partial<ShotUnits>;
}

export interface NormalizedEnvironmentInput {
  windSpeedMps: number;
  windDirectionRad: number;
  altitudeM: number;
  airDensityKgPerM3?: number;
  groundCondition: GroundCondition;
}

export interface NormalizedShotData {
  name: string;
  description?: string;
  ballSpeed: number;
  launchAngle: number;
  launchDirection: number;
  backSpin: number;
  sideSpin: number;
  totalSpin: number;
  spinAxis: number;
  clubType?: CalibrationProfileId;
  environment: NormalizedEnvironmentInput;
  surfaceOverride?: SurfaceType;
  optional: Record<string, number | undefined>;
}
