import type { PhysicsConfig } from "./physicsConfig";
import {
  add,
  cloneVec3,
  cross,
  horizontalLength,
  length,
  normalize,
  scale,
  vec3,
  withY,
  type Vec3,
} from "./vector";
import type { MotionPhase, SimulationState } from "../types/simulation";

export interface GroundStepResult {
  state: SimulationState;
  firstGroundContact: boolean;
}

const clampGroundPosition = (
  position: Vec3,
  radius: number,
): Vec3 => ({
  x: position.x,
  y: radius,
  z: position.z,
});

export const resolveGroundContact = (
  state: SimulationState,
  config: PhysicsConfig,
  surfaceResponse: PhysicsConfig["ground"]["surfaceResponses"][keyof PhysicsConfig["ground"]["surfaceResponses"]],
  hasLanded: boolean,
): GroundStepResult => {
  const clampedPosition = clampGroundPosition(state.position, config.ball.radiusM);
  const horizontalVelocity = withY(state.velocity, 0);
  const downwardSpeed = Math.abs(state.velocity.y);
  const firstGroundContact = !hasLanded;

  if (
    downwardSpeed > surfaceResponse.bounceThresholdMps &&
    state.bounceCount < surfaceResponse.maxBounces
  ) {
    return {
      firstGroundContact,
      state: {
        ...state,
        position: clampedPosition,
        velocity: {
          x: horizontalVelocity.x * surfaceResponse.skidDamping,
          y: downwardSpeed * surfaceResponse.restitution,
          z: horizontalVelocity.z * surfaceResponse.skidDamping,
        },
        spin: scale(state.spin, surfaceResponse.groundSpinRetention),
        bounceCount: state.bounceCount + 1,
        phase: "flight",
      },
    };
  }

  return {
    firstGroundContact,
    state: {
      ...state,
      position: clampedPosition,
      velocity: scale(horizontalVelocity, surfaceResponse.skidDamping),
      spin: scale(state.spin, surfaceResponse.groundSpinRetention),
      phase: "skid",
    },
  };
};

const applySurfaceFriction = (
  velocity: Vec3,
  deceleration: number,
  dt: number,
): Vec3 => {
  const currentHorizontalSpeed = horizontalLength(velocity);
  if (currentHorizontalSpeed === 0) {
    return vec3(0, 0, 0);
  }

  const newSpeed = Math.max(0, currentHorizontalSpeed - deceleration * dt);
  const direction = normalize(withY(velocity, 0));

  return {
    x: direction.x * newSpeed,
    y: 0,
    z: direction.z * newSpeed,
  };
};

const sideScrubKick = (spin: Vec3, velocity: Vec3, strength: number): Vec3 => {
  const direction = normalize(withY(velocity, 0));
  if (length(direction) === 0 || spin.y === 0) {
    return vec3();
  }

  const sideways = normalize(cross(direction, vec3(0, 1, 0)));
  return scale(sideways, spin.y * strength);
};

export const advanceGroundPhase = (
  state: SimulationState,
  config: PhysicsConfig,
  surfaceResponse: PhysicsConfig["ground"]["surfaceResponses"][keyof PhysicsConfig["ground"]["surfaceResponses"]],
  dt: number,
): SimulationState => {
  let phase: MotionPhase = state.phase;
  let velocity = cloneVec3(state.velocity);
  const groundDecayRate = Math.max(
    config.aerodynamics.backSpinDecayRatePerSecond,
    config.aerodynamics.sideSpinDecayRatePerSecond,
  );
  let spin = scale(state.spin, Math.exp(-groundDecayRate * 2.5 * dt));

  if (phase === "skid") {
    velocity = applySurfaceFriction(
      velocity,
      surfaceResponse.skidFrictionAccel,
      dt,
    );
    velocity = add(velocity, sideScrubKick(spin, velocity, -0.0004 * dt));
    if (horizontalLength(velocity) <= surfaceResponse.skidToRollSpeedMps) {
      phase = "roll";
    }
  } else if (phase === "roll") {
    velocity = applySurfaceFriction(
      velocity,
      surfaceResponse.rollFrictionAccel,
      dt,
    );
  }

  if (horizontalLength(velocity) <= config.simulation.restSpeedMps) {
    return {
      ...state,
      position: clampGroundPosition(state.position, config.ball.radiusM),
      velocity: vec3(0, 0, 0),
      spin: vec3(0, 0, 0),
      phase: "rest",
    };
  }

  const position = clampGroundPosition(
    add(state.position, scale(velocity, dt)),
    config.ball.radiusM,
  );

  return {
    ...state,
    position,
    velocity,
    spin,
    phase,
  };
};
