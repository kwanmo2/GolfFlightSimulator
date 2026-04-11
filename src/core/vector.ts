export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

export const vec3 = (x = 0, y = 0, z = 0): Vec3 => ({ x, y, z });

export const add = (a: Vec3, b: Vec3): Vec3 => ({
  x: a.x + b.x,
  y: a.y + b.y,
  z: a.z + b.z,
});

export const subtract = (a: Vec3, b: Vec3): Vec3 => ({
  x: a.x - b.x,
  y: a.y - b.y,
  z: a.z - b.z,
});

export const scale = (value: Vec3, scalar: number): Vec3 => ({
  x: value.x * scalar,
  y: value.y * scalar,
  z: value.z * scalar,
});

export const dot = (a: Vec3, b: Vec3): number =>
  a.x * b.x + a.y * b.y + a.z * b.z;

export const cross = (a: Vec3, b: Vec3): Vec3 => ({
  x: a.y * b.z - a.z * b.y,
  y: a.z * b.x - a.x * b.z,
  z: a.x * b.y - a.y * b.x,
});

export const length = (value: Vec3): number => Math.sqrt(dot(value, value));

export const normalize = (value: Vec3): Vec3 => {
  const magnitude = length(value);
  if (magnitude === 0) {
    return vec3();
  }

  return scale(value, 1 / magnitude);
};

export const withY = (value: Vec3, y: number): Vec3 => ({
  x: value.x,
  y,
  z: value.z,
});

export const horizontalLength = (value: Vec3): number =>
  Math.sqrt(value.x * value.x + value.z * value.z);

export const cloneVec3 = (value: Vec3): Vec3 => ({
  x: value.x,
  y: value.y,
  z: value.z,
});
