export function wrappedFocusIndex(
  triggerIndex: number,
  controlCount: number,
  backwards: boolean,
): number | null {
  if (controlCount <= 0 || triggerIndex < 0 || triggerIndex >= controlCount) return null;
  return backwards
    ? (triggerIndex - 1 + controlCount) % controlCount
    : (triggerIndex + 1) % controlCount;
}
