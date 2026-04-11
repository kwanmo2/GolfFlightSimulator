import type {
  NormalizedEnvironmentInput,
  NormalizedShotData,
  ShotInput,
  ShotUnits,
} from "../types/shot";
import type { GroundCondition } from "../types/simulation";

const DEFAULT_UNITS: ShotUnits = {
  speed: "mph",
  angle: "deg",
  spin: "rpm",
};

const MPH_TO_MPS = 0.44704;
const KPH_TO_MPS = 1000 / 3600;
const RPM_TO_RADPS = (2 * Math.PI) / 60;
const DEFAULT_GROUND_CONDITION: GroundCondition = "normal";

const toMps = (value: number, unit: ShotUnits["speed"]): number => {
  switch (unit) {
    case "mph":
      return value * MPH_TO_MPS;
    case "kph":
      return value * KPH_TO_MPS;
    case "mps":
      return value;
  }
};

const toRadians = (value: number, unit: ShotUnits["angle"]): number => {
  switch (unit) {
    case "deg":
      return (value * Math.PI) / 180;
    case "rad":
      return value;
  }
};

const toRadPerSecond = (value: number, unit: ShotUnits["spin"]): number => {
  switch (unit) {
    case "rpm":
      return value * RPM_TO_RADPS;
    case "radps":
      return value;
  }
};

const toOptionalNumberRecord = (shot: ShotInput): Record<string, number | undefined> => ({
  clubPath: shot.clubPath,
  faceAngle: shot.faceAngle,
  attackAngle: shot.attackAngle,
  dynamicLoft: shot.dynamicLoft,
  clubHeadSpeed: shot.clubHeadSpeed,
  impactPointHV: shot.impactPointHV,
  lowPoint: shot.lowPoint,
  swingPlane: shot.swingPlane,
  swingDirection: shot.swingDirection,
  clubLie: shot.clubLie,
  closureRate: shot.closureRate,
  faceToAxis: shot.faceToAxis,
});

const normalizeEnvironmentInput = (
  shot: ShotInput,
  units: ShotUnits,
): NormalizedEnvironmentInput => ({
  windSpeedMps: toMps(shot.environment?.windSpeed ?? 0, units.speed),
  windDirectionRad: toRadians(shot.environment?.windDirection ?? 0, units.angle),
  altitudeM: shot.environment?.altitude ?? 0,
  airDensityKgPerM3: shot.environment?.airDensity,
  groundCondition: shot.environment?.groundCondition ?? DEFAULT_GROUND_CONDITION,
});

export const normalizeShotInput = (shot: ShotInput): NormalizedShotData => {
  const units: ShotUnits = {
    ...DEFAULT_UNITS,
    ...shot.units,
  };

  if (!Number.isFinite(shot.ballSpeed) || shot.ballSpeed <= 0) {
    throw new Error("ballSpeed must be a positive number.");
  }

  if (!Number.isFinite(shot.launchAngle)) {
    throw new Error("launchAngle must be provided.");
  }

  if (!Number.isFinite(shot.launchDirection)) {
    throw new Error("launchDirection must be provided.");
  }

  const ballSpeed = toMps(shot.ballSpeed, units.speed);
  const launchAngle = toRadians(shot.launchAngle, units.angle);
  const launchDirection = toRadians(shot.launchDirection, units.angle);

  let backSpin = shot.backSpin ?? undefined;
  let sideSpin = shot.sideSpin ?? undefined;
  let totalSpin = shot.totalSpin ?? undefined;
  let spinAxis = shot.spinAxis ?? undefined;

  if (totalSpin === undefined && backSpin !== undefined && sideSpin !== undefined) {
    totalSpin = Math.sqrt(backSpin * backSpin + sideSpin * sideSpin);
  }

  if (spinAxis === undefined && backSpin !== undefined && sideSpin !== undefined) {
    spinAxis = (Math.atan2(sideSpin, backSpin) * 180) / Math.PI;
  }

  if (totalSpin !== undefined && (backSpin === undefined || sideSpin === undefined)) {
    const axisRadians = toRadians(spinAxis ?? 0, units.angle);
    backSpin = totalSpin * Math.cos(axisRadians);
    sideSpin = totalSpin * Math.sin(axisRadians);
  }

  backSpin ??= 0;
  sideSpin ??= 0;
  totalSpin ??= Math.sqrt(backSpin * backSpin + sideSpin * sideSpin);
  spinAxis ??= (Math.atan2(sideSpin, backSpin || 1) * 180) / Math.PI;

  return {
    name: shot.name ?? "Custom Shot",
    description: shot.description,
    ballSpeed,
    launchAngle,
    launchDirection,
    backSpin: toRadPerSecond(backSpin, units.spin),
    sideSpin: toRadPerSecond(sideSpin, units.spin),
    totalSpin: toRadPerSecond(totalSpin, units.spin),
    spinAxis: toRadians(spinAxis, units.angle),
    clubType: shot.clubType,
    environment: normalizeEnvironmentInput(shot, units),
    surfaceOverride: shot.surfaceOverride,
    optional: toOptionalNumberRecord(shot),
  };
};

export const metersToYards = (meters: number): number => meters * 1.09361;
export const radiansPerSecondToRpm = (radiansPerSecond: number): number =>
  radiansPerSecond / RPM_TO_RADPS;
