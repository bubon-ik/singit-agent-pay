/** Fixed-window per-client limiter for the public HTTP transport. In-memory; one process. */
export function createRateLimiter(limitPerMinute: number, now: () => number = Date.now) {
  const windows = new Map<string, { start: number; count: number }>();
  return function allow(client: string): boolean {
    if (limitPerMinute <= 0) return true;
    const t = now();
    const w = windows.get(client);
    if (!w || t - w.start >= 60_000) {
      windows.set(client, { start: t, count: 1 });
      if (windows.size > 10_000) windows.clear(); // crude memory bound
      return true;
    }
    w.count += 1;
    return w.count <= limitPerMinute;
  };
}
