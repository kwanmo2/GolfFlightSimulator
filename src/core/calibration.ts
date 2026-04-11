import type { PhysicsConfig } from "./physicsConfig";
import { vec3 } from "./vector";
import type { NormalizedShotData } from "../types/shot";
import type {
  CalibrationProfile,
  CalibrationProfileId,
  EnvironmentState,
  GroundCondition,
  SurfaceType,
} from "../types/simulation";

const AIR_DENSITY_SCALE_HEIGHT_M = 8500;

const CALIBRATION_PROFILES: Record<CalibrationProfileId, CalibrationProfile> = {
  driver: {
    id: "driver",
    label: "Driver",
    description: "Lower spin and longer rollout for tee shots.",
    aerodynamicMultiplier: {
      drag: 0.97,
      backSpinLift: 0.95,
      sideSpinCurve: 0.98,
      backSpinDecay: 1.05,
      sideSpinDecay: 1.02,
    },
    groundMultiplier: {
      restitution: 1.04,
      skidDamping: 1,
      skidFriction: 0.92,
      rollFriction: 0.88,
    },
  },
  long_iron: {
    id: "long_iron",
    label: "Long Iron",
    description: "Mid-spin flight with controlled rollout.",
    aerodynamicMultiplier: {
      drag: 1,
      backSpinLift: 1,
      sideSpinCurve: 1,
      backSpinDecay: 1,
      sideSpinDecay: 1,
    },
    groundMultiplier: {
      restitution: 0.99,
      skidDamping: 0.99,
      skidFriction: 1,
      rollFriction: 1,
    },
  },
  short_iron: {
    id: "short_iron",
    label: "Short Iron",
    description: "Higher launch and more stopping power.",
    aerodynamicMultiplier: {
      drag: 1.03,
      backSpinLift: 1.05,
      sideSpinCurve: 0.98,
      backSpinDecay: 0.98,
      sideSpinDecay: 1.02,
    },
    groundMultiplier: {
      restitution: 0.95,
      skidDamping: 0.96,
      skidFriction: 1.08,
      rollFriction: 1.12,
    },
  },
  wedge: {
    id: "wedge",
    label: "Wedge",
    description: "Steeper, floaty flight with faster stop after landing.",
    aerodynamicMultiplier: {
      drag: 1.08,
      backSpinLift: 1.12,
      sideSpinCurve: 0.94,
      backSpinDecay: 0.94,
      sideSpinDecay: 1.04,
    },
    groundMultiplier: {
      restitution: 0.9,
      skidDamping: 0.93,
      skidFriction: 1.18,
      rollFriction: 1.2,
    },
  },
  putt_like: {
    id: "putt_like",
    label: "Low Speed",
    description: "Very low-speed strike with almost no meaningful lift.",
    aerodynamicMultiplier: {
      drag: 1.02,
      backSpinLift: 0.35,
      sideSpinCurve: 0.3,
      backSpinDecay: 1.4,
      sideSpinDecay: 1.4,
    },
    groundMultiplier: {
      restitution: 0.78,
      skidDamping: 0.9,
      skidFriction: 1.22,
      rollFriction: 0.94,
    },
  },
};

const DEFAULT_PROFILE_ID: CalibrationProfileId = "driver";

const recommendProfileId = (shot: NormalizedShotData): CalibrationProfileId => {
  const speed = shot.ballSpeed;
  const launchAngleDeg = (shot.launchAngle * 180) / Math.PI;
  const totalSpinRpm = (shot.totalSpin * 60) / (2 * Math.PI);

  if (speed < 18) {
    return "putt_like";
  }
  if (launchAngleDeg > 24 || totalSpinRpm > 7000 || speed < 50) {
    return "wedge";
  }
  if (launchAngleDeg > 17 || speed < 63) {
    return "short_iron";
  }
  if (speed < 74) {
    return "long_iron";
  }
  return "driver";
};

export const resolveCalibrationProfile = (
  shot: NormalizedShotData,
): {
  profile: CalibrationProfile;
  profileId: CalibrationProfileId;
  recommendedProfileId: CalibrationProfileId;
} => {
  const recommendedProfileId = recommendProfileId(shot);
  const profileId = shot.clubType ?? DEFAULT_PROFILE_ID;

  return {
    profile: CALIBRATION_PROFILES[profileId],
    profileId,
    recommendedProfileId,
  };
};

const airDensityFromAltitude = (
  baseDensityKgPerM3: number,
  altitudeM: number,
): number => baseDensityKgPerM3 * Math.exp(-Math.max(0, altitudeM) / AIR_DENSITY_SCALE_HEIGHT_M);

export const buildEnvironmentState = (
  shot: NormalizedShotData,
  config: PhysicsConfig,
): EnvironmentState => {
  const airDensityKgPerM3 =
    shot.environment.airDensityKgPerM3 ??
    airDensityFromAltitude(config.environment.airDensityKgPerM3, shot.environment.altitudeM);

  return {
    windSpeedMps: shot.environment.windSpeedMps,
    windDirectionRad: shot.environment.windDirectionRad,
    // Wind direction uses the same horizontal convention as launchDirection:
    // 0 rad = downrange tailwind, +angle = wind traveling toward golfer's right.
    windVector: vec3(
      shot.environment.windSpeedMps * Math.sin(shot.environment.windDirectionRad),
      0,
      shot.environment.windSpeedMps * Math.cos(shot.environment.windDirectionRad),
    ),
    altitudeM: shot.environment.altitudeM,
    airDensityKgPerM3,
    groundCondition: shot.environment.groundCondition,
  };
};

const groundConditionMultiplier = (
  condition: GroundCondition,
): {
  restitution: number;
  skidDamping: number;
  skidFriction: number;
  rollFriction: number;
} => {
  switch (condition) {
    case "dry":
      return {
        restitution: 1.05,
        skidDamping: 1.01,
        skidFriction: 0.92,
        rollFriction: 0.9,
      };
    case "wet":
      return {
        restitution: 0.92,
        skidDamping: 0.95,
        skidFriction: 1.18,
        rollFriction: 1.16,
      };
    default:
      return {
        restitution: 1,
        skidDamping: 1,
        skidFriction: 1,
        rollFriction: 1,
      };
  }
};

export const getSurfaceResponse = (
  config: PhysicsConfig,
  surface: SurfaceType,
  profile: CalibrationProfile,
  groundCondition: GroundCondition,
) => {
  const base = config.ground.surfaceResponses[surface];
  const condition = groundConditionMultiplier(groundCondition);

  return {
    restitution: base.restitution * profile.groundMultiplier.restitution * condition.restitution,
    skidDamping: Math.min(
      1,
      base.skidDamping * profile.groundMultiplier.skidDamping * condition.skidDamping,
    ),
    skidFrictionAccel:
      base.skidFrictionAccel *
      profile.groundMultiplier.skidFriction *
      condition.skidFriction,
    skidToRollSpeedMps: base.skidToRollSpeedMps,
    rollFrictionAccel:
      base.rollFrictionAccel *
      profile.groundMultiplier.rollFriction *
      condition.rollFriction,
    bounceThresholdMps: base.bounceThresholdMps,
    maxBounces: base.maxBounces,
    groundSpinRetention: base.groundSpinRetention,
  };
};

