// waitSeconds for run-script tools: default 30 s, clamped to 1-600 s, returned in milliseconds.
export const DEFAULT_WAIT_SECONDS = 30;
export const MAX_WAIT_SECONDS = 600;

export function waitSecondsToMs(waitSeconds: number | undefined = DEFAULT_WAIT_SECONDS): number {
  const s = Number(waitSeconds);
  return Math.min(Math.max(Number.isNaN(s) ? DEFAULT_WAIT_SECONDS : s, 1), MAX_WAIT_SECONDS) * 1000;
}
