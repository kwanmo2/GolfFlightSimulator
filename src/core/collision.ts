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
  withY,
  type Vec3,
} from "./vector";
import type { MotionPhase, SimulationState } from "../types/simulation";

export interface GroundStepResult {
  state: SimulationState;
  firstGroundContact: boolean;
}

/** Height of the ground surface (world Y, metres) at a point on the XZ plane. */
export type GroundHeightResolver = (x: number, z: number) => number;

/** The ground the ball lands and rolls on. Normals point up out of the ground. */
export interface GroundModel {
  heightAt(x: number, z: number): number;
  normalAt(x: number, z: number): Vec3;
}

type SurfaceResponse =
  PhysicsConfig["ground"]["surfaceResponses"][keyof PhysicsConfig["ground"]["surfaceResponses"]];

/** Half-spacing of the central difference used to estimate the ground slope. */
const NORMAL_SAMPLE_OFFSET_M = 0.25;

/**
 * A solid sphere rolling without slipping accelerates down a slope at 5/7 of
 * the rate of a sliding point mass.
 */
const ROLLING_SPHERE_SLOPE_FACTOR = 5 / 7;

const FLAT_GROUND: GroundModel = {
  heightAt: () => 0,
  normalAt: () => vec3(0, 1, 0),
};

/**
 * Wrap a height lookup as a ground model. Without one the ground is the flat
 * y = 0 plane; every rule below reduces to the level-ground behaviour there.
 */
export const createGroundModel = (heightAt?: GroundHeightResolver): GroundModel => {
  if (!heightAt) {
    return FLAT_GROUND;
  }
  return {
    heightAt,
    normalAt(x, z) {
      const offset = NORMAL_SAMPLE_OFFSET_M;
      const slopeX = (heightAt(x + offset, z) - heightAt(x - offset, z)) / (2 * offset);
      const slopeZ = (heightAt(x, z + offset) - heightAt(x, z - offset)) / (2 * offset);
      return normalize(vec3(-slopeX, 1, -slopeZ));
    },
  };
};

/** Ball centre resting one radius above the ground. */
const groundPosition = (position: Vec3, radius: number, ground: GroundModel): Vec3 => ({
  x: position.x,
  y: ground.heightAt(position.x, position.z) + radius,
  z: position.z,
});

/**
 * Horizontal part of gravity along the slope: the downhill pull on a ball
 * that is on the ground. Zero on level ground.
 */
const slopeAcceleration = (normal: Vec3, gravityMps2: number): Vec3 =>
  scale(vec3(normal.x, 0, normal.z), gravityMps2 * normal.y * ROLLING_SPHERE_SLOPE_FACTOR);

/**
 * Bounce or start skidding on contact. Velocity is split into the part along
 * the ground normal, which rebounds with the surface restitution, and the part
 * along the ground, which is damped. On a slope this kicks the ball off mounds
 * and banks; on level ground it is a plain vertical bounce.
 */
export const resolveGroundContact = (
  state: SimulationState,
  config: PhysicsConfig,
  surfaceResponse: SurfaceResponse,
  hasLanded: boolean,
  ground: GroundModel = FLAT_GROUND,
): GroundStepResult => {
  const clampedPosition = groundPosition(state.position, config.ball.radiusM, ground);
  const normal = ground.normalAt(state.position.x, state.position.z);
  const normalSpeed = dot(state.velocity, normal);
  const tangentialVelocity = subtract(state.velocity, scale(normal, normalSpeed));
  const impactSpeed = Math.abs(normalSpeed);
  const firstGroundContact = !hasLanded;

  if (
    impactSpeed > surfaceResponse.bounceThresholdMps &&
    state.bounceCount < surfaceResponse.maxBounces
  ) {
    return {
      firstGroundContact,
      state: {
        ...state,
        position: clampedPosition,
        velocity: add(
          scale(tangentialVelocity, surfaceResponse.skidDamping),
          scale(normal, impactSpeed * surfaceResponse.restitution),
        ),
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
      velocity: scale(withY(tangentialVelocity, 0), surfaceResponse.skidDamping),
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

/**
 * Skid and roll along the ground. Velocity stays horizontal and the ball is
 * kept on the surface. Slopes add a downhill pull, and the ball only comes to
 * rest once friction is strong enough to hold it there.
 */
export const advanceGroundPhase = (
  state: SimulationState,
  config: PhysicsConfig,
  surfaceResponse: SurfaceResponse,
  dt: number,
  ground: GroundModel = FLAT_GROUND,
): SimulationState => {
  let phase: MotionPhase = state.phase;
  const slopePull = slopeAcceleration(
    ground.normalAt(state.position.x, state.position.z),
    config.environment.gravityMps2,
  );
  let velocity = add(cloneVec3(state.velocity), scale(slopePull, dt));
  const groundDecayRate = Math.max(
    config.aerodynamics.backSpinDecayRatePerSecond,
    config.aerodynamics.sideSpinDecayRatePerSecond,
  );
  let spin = scale(state.spin, Math.exp(-groundDecayRate * 2.5 * dt));
  const frictionAccel =
    phase === "skid" ? surfaceResponse.skidFrictionAccel : surfaceResponse.rollFrictionAccel;

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

  const slopeHeld = length(slopePull) <= frictionAccel;
  if (horizontalLength(velocity) <= config.simulation.restSpeedMps && slopeHeld) {
    return {
      ...state,
      position: groundPosition(state.position, config.ball.radiusM, ground),
      velocity: vec3(0, 0, 0),
      spin: vec3(0, 0, 0),
      phase: "rest",
    };
  }

  const position = groundPosition(
    add(state.position, scale(velocity, dt)),
    config.ball.radiusM,
    ground,
  );

  return {
    ...state,
    position,
    velocity,
    spin,
    phase,
  };
};
