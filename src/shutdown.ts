export interface SignalSource {
  on(signal: "SIGINT" | "SIGTERM", listener: () => void): unknown;
}

/**
 * Call `handler` once on the first SIGINT/SIGTERM and keep listening afterwards.
 * Under `tsx`, Ctrl+C reaches the app twice (from the terminal and relayed by tsx);
 * with a one-shot listener the repeat would hit Node's default action and kill the
 * process before the clean-shutdown marker is written.
 */
export function onShutdownSignal(handler: (signal: "SIGINT" | "SIGTERM") => void, source: SignalSource = process): void {
  let started = false;
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    source.on(signal, () => {
      if (started) return;
      started = true;
      handler(signal);
    });
  }
}
