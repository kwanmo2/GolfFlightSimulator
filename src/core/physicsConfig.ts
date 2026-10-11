import type { SurfaceType } from "../types/simulation";

export interface PhysicsConfig {
  ball: {
    massKg: number;
    radiusM: number;
    areaM2: number;
  };
  environment: {
    gravityMps2: number;
    airDensityKgPerM3: number;
    teeHeightM: number;
  };
  aerodynamics: {
    dragCoefficient: number;
    backSpinLiftCoefficient: number;
    sideSpinCurveCoefficient: number;
    liftSaturation: number;
    sideSpinSaturation: number;
    backSpinDecayRatePerSecond: number;
    sideSpinDecayRatePerSecond: number;
  };
  ground: {
    surfaceResponses: Record<
      SurfaceType,
      {
        restitution: number;
        skidDamping: number;
        skidFrictionAccel: number;
        skidToRollSpeedMps: number;
        rollFrictionAccel: number;
        bounceThresholdMps: number;
        maxBounces: number;
        groundSpinRetention: number;
      }
    >;
  };
  simulation: {
    fixedTimestep: number;
    maxTimeS: number;
    restSpeedMps: number;
  };
}

const BALL_RADIUS_M = 0.02135;

export const defaultPhysicsConfig = (): PhysicsConfig => ({
  ball: {
    massKg: 0.04593,
    radiusM: BALL_RADIUS_M,
    areaM2: Math.PI * BALL_RADIUS_M * BALL_RADIUS_M,
  },
  environment: {
    gravityMps2: 9.81,
    airDensityKgPerM3: 1.225,
    teeHeightM: 0.03,
  },
  aerodynamics: {
    dragCoefficient: 0.25,
    backSpinLiftCoefficient: 0.24,
    sideSpinCurveCoefficient: 0.11,
    liftSaturation: 3.6,
    sideSpinSaturation: 4.8,
    backSpinDecayRatePerSecond: 0.11,
    sideSpinDecayRatePerSecond: 0.18,
  },
  ground: {
    surfaceResponses: {
      tee: {
        restitution: 0.4,
        skidDamping: 0.84,
        skidFrictionAccel: 7.2,
        skidToRollSpeedMps: 8.2,
        rollFrictionAccel: 2.2,
        bounceThresholdMps: 1.8,
        maxBounces: 3,
        groundSpinRetention: 0.74,
      },
      fairway: {
        restitution: 0.38,
        skidDamping: 0.82,
        skidFrictionAccel: 7.8,
        skidToRollSpeedMps: 8,
        rollFrictionAccel: 2.4,
        bounceThresholdMps: 1.8,
        maxBounces: 3,
        groundSpinRetention: 0.72,
      },
      rough: {
        restitution: 0.22,
        skidDamping: 0.74,
        skidFrictionAccel: 10.8,
        skidToRollSpeedMps: 6.2,
        rollFrictionAccel: 4.2,
        bounceThresholdMps: 1.5,
        maxBounces: 2,
        groundSpinRetention: 0.58,
      },
      green: {
        restitution: 0.2,
        skidDamping: 0.72,
        skidFrictionAccel: 10.4,
        skidToRollSpeedMps: 4.8,
        rollFrictionAccel: 1.65,
        bounceThresholdMps: 1.3,
        maxBounces: 2,
        groundSpinRetention: 0.5,
      },
      bunker: {
        restitution: 0.08,
        skidDamping: 0.58,
        skidFrictionAccel: 15.5,
        skidToRollSpeedMps: 2.8,
        rollFrictionAccel: 6.5,
        bounceThresholdMps: 0.9,
        maxBounces: 1,
        groundSpinRetention: 0.34,
      },
      fringe: {
        restitution: 0.26,
        skidDamping: 0.76,
        skidFrictionAccel: 9.1,
        skidToRollSpeedMps: 5.2,
        rollFrictionAccel: 2.15,
        bounceThresholdMps: 1.4,
        maxBounces: 2,
        groundSpinRetention: 0.62,
      },
      // A hazard, not a playing surface: the ball never bounces and is
      // stopped within a few steps, settling on the pond bed.
      water: {
        restitution: 0,
        skidDamping: 0.05,
        skidFrictionAccel: 80,
        skidToRollSpeedMps: 0,
        rollFrictionAccel: 80,
        bounceThresholdMps: 1000,
        maxBounces: 0,
        groundSpinRetention: 0,
      },
    },
  },
  simulation: {
    fixedTimestep: 1 / 120,
    maxTimeS: 14,
    restSpeedMps: 0.25,
  },
});
