import type { PhysicsConfig } from "./physicsConfig";
import {
  add,
  cloneVec3,
  cross,
  dot,
  horizontalLength,
  length,
  normalize,
  scale,
  subtract,
  vec3,
} from "./vector";
import {
  buildEnvironmentState,
  getSurfaceResponse,
  resolveCalibrationProfile,
} from "./calibration";
import { advanceGroundPhase, createGroundModel, resolveGroundContact } from "./collision";
import type { GroundHeightResolver } from "./collision";
import type { NormalizedShotData } from "../types/shot";
import type {
  InitialConditions,
  ShotAnalysisMetrics,
  SimulationFrame,
  SimulationResult,
  SimulationState,
  SurfaceType,
  TrajectorySegments,
} from "../types/simulation";

const WORLD_UP = vec3(0, 1, 0);
const DEFAULT_SURFACE: SurfaceType = "fairway";

export interface SimulationContext {
  config: PhysicsConfig;
  shot: NormalizedShotData;
  surfaceResolver?: (x: number, z: number) => SurfaceType;
  /** Ground height lookup; the ground is the flat y = 0 plane when omitted. */
  groundHeightResolver?: GroundHeightResolver;
}

const captureFrame = (state: SimulationState): SimulationFrame => ({
  time: state.time,
  position: cloneVec3(state.position),
  velocity: cloneVec3(state.velocity),
  spin: cloneVec3(state.spin),
  phase: state.phase,
  surface: state.surface,
});

const rightFromForward = (forward: ReturnType<typeof normalize>) => {
  const lateral = cross(WORLD_UP, forward);
  const magnitude = length(lateral);

  if (magnitude === 0) {
    return vec3(1, 0, 0);
  }

  return scale(lateral, 1 / magnitude);
};

const signedSpinComponents = (
  spin: ReturnType<typeof vec3>,
  forward: ReturnType<typeof normalize>,
) => {
  const right = rightFromForward(forward);

  return {
    right,
    backSpin: -dot(spin, right),
    sideSpin: dot(spin, WORLD_UP),
  };
};

const saturatedSpinCoefficient = (
  baseCoefficient: number,
  spinRate: number,
  speed: number,
  ballRadiusM: number,
  saturation: number,
): number => {
  const spinRatio = (Math.abs(spinRate) * ballRadiusM) / Math.max(speed, 0.1);
  return baseCoefficient * (spinRatio / (1 + saturation * spinRatio));
};

const defaultSurfaceResolver = (x: number, z: number): SurfaceType => {
  if (z < 10 && Math.abs(x) < 8) {
    return "tee";
  }

  return DEFAULT_SURFACE;
};

const resolveSurfaceType = (
  shot: NormalizedShotData,
  x: number,
  z: number,
  surfaceResolver?: (x: number, z: number) => SurfaceType,
): SurfaceType => shot.surfaceOverride ?? surfaceResolver?.(x, z) ?? defaultSurfaceResolver(x, z);

const buildInitialMetrics = (
  shot: NormalizedShotData,
  profileId: ShotAnalysisMetrics["profileId"],
  recommendedProfileId: ShotAnalysisMetrics["recommendedProfileId"],
): ShotAnalysisMetrics => ({
  ballSpeedMps: shot.ballSpeed,
  launchAngleDeg: (shot.launchAngle * 180) / Math.PI,
  launchDirectionDeg: (shot.launchDirection * 180) / Math.PI,
  spinRpm: (shot.totalSpin * 60) / (2 * Math.PI),
  carryDistanceM: 0,
  totalDistanceM: 0,
  apexHeightM: 0,
  flightTimeS: 0,
  hangTimeS: 0,
  lateralDeviationM: 0,
  landingAngleDeg: 0,
  descentAngleDeg: 0,
  landingPoint: null,
  landingSurface: null,
  profileId,
  recommendedProfileId,
});

/**
 * Apex is measured from the ground the ball was struck from, so a raised tee
 * box does not inflate it.
 */
const updateMetrics = (
  metrics: ShotAnalysisMetrics,
  state: SimulationState,
  launchGroundY: number,
): ShotAnalysisMetrics => {
  metrics.totalDistanceM = horizontalLength(state.position);
  metrics.apexHeightM = Math.max(metrics.apexHeightM, state.position.y - launchGroundY);
  metrics.lateralDeviationM = state.position.x;

  return metrics;
};

const approachAngleDeg = (velocity: ReturnType<typeof vec3>): number =>
  (Math.atan2(Math.abs(velocity.y), Math.max(0.001, horizontalLength(velocity))) * 180) /
  Math.PI;

const recordLanding = (
  metrics: ShotAnalysisMetrics,
  landingPosition: ReturnType<typeof vec3>,
  impactVelocity: ReturnType<typeof vec3>,
  landingSurface: SurfaceType,
  timeS: number,
): ShotAnalysisMetrics => {
  if (metrics.landingPoint !== null) {
    return metrics;
  }

  metrics.carryDistanceM = horizontalLength(landingPosition);
  metrics.flightTimeS = timeS;
  metrics.hangTimeS = timeS;
  metrics.lateralDeviationM = landingPosition.x;
  metrics.landingPoint = cloneVec3(landingPosition);
  // In this simplified model both metrics come from the first-impact approach vector.
  metrics.landingAngleDeg = approachAngleDeg(impactVelocity);
  metrics.descentAngleDeg = approachAngleDeg(impactVelocity);
  metrics.landingSurface = landingSurface;
  return metrics;
};

const decaySpin = (
  state: SimulationState,
  config: PhysicsConfig,
  context: Pick<SimulationResult, "environment" | "profile">,
  dt: number,
) => {
  const speed = length(state.velocity);
  const forward = speed > 0 ? normalize(state.velocity) : vec3(0, 0, 1);
  const { right, backSpin, sideSpin } = signedSpinComponents(state.spin, forward);

  const decayedBackSpin =
    backSpin *
    Math.exp(
      -config.aerodynamics.backSpinDecayRatePerSecond *
        context.profile.aerodynamicMultiplier.backSpinDecay *
        dt,
    );
  const decayedSideSpin =
    sideSpin *
    Math.exp(
      -config.aerodynamics.sideSpinDecayRatePerSecond *
        context.profile.aerodynamicMultiplier.sideSpinDecay *
        dt,
    );

  return add(scale(right, -decayedBackSpin), scale(WORLD_UP, decayedSideSpin));
};

const computeFlightAcceleration = (
  state: SimulationState,
  config: PhysicsConfig,
  context: Pick<SimulationResult, "environment" | "profile">,
) => {
  const airVelocity = subtract(state.velocity, context.environment.windVector);
  const airSpeed = length(airVelocity);
  const gravity = vec3(0, -config.environment.gravityMps2, 0);

  if (airSpeed === 0) {
    return gravity;
  }

  const forward = normalize(airVelocity);
  const { right, backSpin, sideSpin } = signedSpinComponents(state.spin, forward);
  const dynamicPressure =
    0.5 * context.environment.airDensityKgPerM3 * config.ball.areaM2 * airSpeed * airSpeed;

  const dragMagnitude =
    (dynamicPressure *
      config.aerodynamics.dragCoefficient *
      context.profile.aerodynamicMultiplier.drag) /
    config.ball.massKg;
  const drag = scale(forward, -dragMagnitude);

  const liftCoefficient = saturatedSpinCoefficient(
    config.aerodynamics.backSpinLiftCoefficient *
      context.profile.aerodynamicMultiplier.backSpinLift,
    backSpin,
    airSpeed,
    config.ball.radiusM,
    config.aerodynamics.liftSaturation,
  );
  const sideCoefficient = saturatedSpinCoefficient(
    config.aerodynamics.sideSpinCurveCoefficient *
      context.profile.aerodynamicMultiplier.sideSpinCurve,
    sideSpin,
    airSpeed,
    config.ball.radiusM,
    config.aerodynamics.sideSpinSaturation,
  );

  // This is a stable Magnus-style approximation, not a rigid-body spin-axis solver.
  // Lift is driven by the backspin component, while lateral curve comes from the
  // signed sidespin component around world-up.
  const liftDirection = normalize(cross(scale(right, -1), airVelocity));
  const sideDirection = normalize(cross(WORLD_UP, airVelocity));

  const lift = scale(
    liftDirection,
    (dynamicPressure * Math.sign(backSpin) * liftCoefficient) / config.ball.massKg,
  );
  const sideForce = scale(
    sideDirection,
    (dynamicPressure * Math.sign(sideSpin) * sideCoefficient) / config.ball.massKg,
  );

  return add(add(add(gravity, drag), lift), sideForce);
};

export const simulateBallFlight = (
  initialConditions: InitialConditions,
  context: SimulationContext,
): SimulationResult => {
  const { config, shot, surfaceResolver } = context;
  const ground = createGroundModel(context.groundHeightResolver);
  const { profile, profileId, recommendedProfileId } = resolveCalibrationProfile(shot);
  const environment = buildEnvironmentState(shot, config);
  const dt = config.simulation.fixedTimestep;
  const maxSteps = Math.ceil(config.simulation.maxTimeS / dt);
  const frames: SimulationFrame[] = [];
  const metrics = buildInitialMetrics(shot, profileId, recommendedProfileId);
  const segments: TrajectorySegments = {
    carryEndIndex: 0,
    rollStartIndex: null,
  };

  // Initial conditions are relative to level ground; lift them onto the tee.
  const launchGroundY = ground.heightAt(initialConditions.position.x, initialConditions.position.z);
  let state: SimulationState = {
    ...initialConditions,
    position: add(initialConditions.position, vec3(0, launchGroundY, 0)),
    time: 0,
    phase: "flight",
    bounceCount: 0,
    surface: resolveSurfaceType(shot, initialConditions.position.x, initialConditions.position.z, surfaceResolver),
  };
  let hasLanded = false;

  frames.push(captureFrame(state));
  updateMetrics(metrics, state, launchGroundY);

  for (let step = 0; step < maxSteps; step += 1) {
    if (state.phase === "flight") {
      const acceleration = computeFlightAcceleration(state, config, { environment, profile });
      const nextVelocity = add(state.velocity, scale(acceleration, dt));
      const nextPosition = add(state.position, scale(nextVelocity, dt));
      const nextSpin = decaySpin(state, config, { environment, profile }, dt);

      state = {
        ...state,
        time: state.time + dt,
        velocity: nextVelocity,
        position: nextPosition,
        spin: nextSpin,
      };

      const groundSurface = resolveSurfaceType(shot, state.position.x, state.position.z, surfaceResolver);
      state.surface = groundSurface;

      const groundY = ground.heightAt(state.position.x, state.position.z);
      if (state.position.y <= groundY + config.ball.radiusM) {
        const landingPosition = vec3(state.position.x, groundY + config.ball.radiusM, state.position.z);
        const impactVelocity = cloneVec3(state.velocity);
        const surfaceResponse = getSurfaceResponse(
          config,
          groundSurface,
          profile,
          environment.groundCondition,
        );
        const result = resolveGroundContact(state, config, surfaceResponse, hasLanded, ground);
        state = {
          ...result.state,
          time: state.time,
          surface: groundSurface,
        };

        if (result.firstGroundContact) {
          recordLanding(metrics, landingPosition, impactVelocity, groundSurface, state.time);
          segments.carryEndIndex = frames.length;
        }
        hasLanded = hasLanded || result.firstGroundContact;
      }
    } else if (state.phase === "skid" || state.phase === "roll") {
      const groundSurface = resolveSurfaceType(shot, state.position.x, state.position.z, surfaceResolver);
      const surfaceResponse = getSurfaceResponse(
        config,
        groundSurface,
        profile,
        environment.groundCondition,
      );
      state = {
        ...advanceGroundPhase(
          {
            ...state,
            surface: groundSurface,
          },
          config,
          surfaceResponse,
          dt,
          ground,
        ),
        time: state.time + dt,
        surface: groundSurface,
      };
    } else {
      state = {
        ...state,
        time: state.time + dt,
      };
    }

    if (segments.rollStartIndex === null && state.phase === "roll") {
      segments.rollStartIndex = frames.length;
    }

    frames.push(captureFrame(state));
    updateMetrics(metrics, state, launchGroundY);

    if (state.phase === "rest") {
      break;
    }
  }

  if (metrics.landingPoint === null) {
    metrics.flightTimeS = state.time;
    metrics.hangTimeS = state.time;
    metrics.carryDistanceM = metrics.totalDistanceM;
    metrics.lateralDeviationM = state.position.x;
    metrics.landingSurface = state.surface;
    metrics.descentAngleDeg = approachAngleDeg(state.velocity);
    metrics.landingAngleDeg = metrics.descentAngleDeg;
    segments.carryEndIndex = Math.max(0, frames.length - 1);
  }

  metrics.apexHeightM = Math.max(0, metrics.apexHeightM - config.ball.radiusM);

  return {
    config,
    environment,
    profile,
    frames,
    metrics,
    segments,
  };
};
