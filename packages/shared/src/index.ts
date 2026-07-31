export const U64_MAX = (1n << 64n) - 1n;

export function checkedAdd(left: bigint, right: bigint, maximum = U64_MAX): bigint {
  const result = left + right;
  if (left < 0n || right < 0n || result > maximum) throw new RangeError("Integer addition out of range");
  return result;
}

export function checkedSub(left: bigint, right: bigint): bigint {
  if (left < 0n || right < 0n || right > left) throw new RangeError("Integer subtraction out of range");
  return left - right;
}

export function mulDivFloor(multiplicand: bigint, multiplier: bigint, divisor: bigint): bigint {
  if (multiplicand < 0n || multiplier < 0n || divisor <= 0n) throw new RangeError("Invalid mulDiv operands");
  return multiplicand * multiplier / divisor;
}

export function mulDivCeil(multiplicand: bigint, multiplier: bigint, divisor: bigint): bigint {
  if (multiplicand < 0n || multiplier < 0n || divisor <= 0n) throw new RangeError("Invalid mulDiv operands");
  const product = multiplicand * multiplier;
  return product === 0n ? 0n : (product + divisor - 1n) / divisor;
}
