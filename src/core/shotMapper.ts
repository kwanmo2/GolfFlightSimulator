import type { PhysicsConfig } from "./physicsConfig";
import { add, cross, normalize, scale, vec3 } from "./vector";
import type { NormalizedShotData } from "../types/shot";
import type { InitialConditions } from "../types/simulation";

const WORLD_UP = vec3(0, 1, 0);

const rightFromForward = (forward: ReturnType<typeof normalize>) => {
  const lateral = cross(WORLD_UP, forward);
  const magnitude = Math.sqrt(
    lateral.x * lateral.x + lateral.y * lateral.y + lateral.z * lateral.z,
  );

  if (magnitude === 0) {
    return vec3(1, 0, 0);
  }

  return scale(lateral, 1 / magnitude);
};

export const mapShotToInitialConditions = (
  shot: NormalizedShotData,
  config: PhysicsConfig,
): InitialConditions => {
  const horizontalSpeed = shot.ballSpeed * Math.cos(shot.launchAngle);

  // Coordinate convention:
  // +Y = up, +Z = downrange/target line, +X = golfer's right.
  // Positive launchDirection starts the shot to the right.
  const velocity = vec3(
    horizontalSpeed * Math.sin(shot.launchDirection),
    shot.ballSpeed * Math.sin(shot.launchAngle),
    horizontalSpeed * Math.cos(shot.launchDirection),
  );

  const forward = normalize(velocity);
  const right = rightFromForward(forward);

  // Sign convention for curvature:
  // positive sideSpin / positive spinAxis = fade or slice, curving toward +X.
  // We therefore keep side spin aligned with +Y so omega x v points to +X.
  // Backspin is attached to the local -right axis, which preserves upward lift
  // even after the initial launch direction changes.
  const spin = add(
    scale(right, -shot.backSpin),
    scale(WORLD_UP, shot.sideSpin),
  );

  return {
    position: vec3(0, config.ball.radiusM + config.environment.teeHeightM, 0),
    velocity,
    spin,
  };
};
