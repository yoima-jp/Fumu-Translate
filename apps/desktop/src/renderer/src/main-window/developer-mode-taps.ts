export const DEVELOPER_MODE_TAP_TARGET = 10;
export const DEVELOPER_MODE_TAP_WINDOW_MS = 4_000;

export interface DeveloperModeTapResult {
  readonly recentTaps: readonly number[];
  readonly unlocked: boolean;
}

export function recordDeveloperModeTap(
  previousTaps: readonly number[],
  now: number,
): DeveloperModeTapResult {
  const recentTaps = [
    ...previousTaps.filter((tap) => now - tap <= DEVELOPER_MODE_TAP_WINDOW_MS),
    now,
  ];
  return {
    recentTaps: recentTaps.slice(-DEVELOPER_MODE_TAP_TARGET),
    unlocked: recentTaps.length >= DEVELOPER_MODE_TAP_TARGET,
  };
}
