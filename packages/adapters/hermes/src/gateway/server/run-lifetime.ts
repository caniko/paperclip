/** An uncertain admission is replayed with the original idempotency identity.
 * Cancellation cannot abandon a POST that may already have admitted work. */
export async function admitOwnedRun<T>(input: {
  create: () => Promise<T>;
  stopAdmission: () => Promise<T>;
  shouldStop: () => boolean;
  onUncertain: (error: unknown) => Promise<void>;
  retryMs: number;
}): Promise<T> {
  let uncertain = false;
  for (;;) {
    try {
      return await (input.shouldStop() ? input.stopAdmission() : input.create());
    } catch (error) {
      const status = (error as { status?: number }).status;
      if (!uncertain && status && status >= 400 && status < 500 && status !== 408) throw error;
      uncertain = true;
      // Diagnostics must not release an admission whose acknowledgement was lost.
      try { await input.onUncertain(error); } catch { /* retain ownership */ }
      await new Promise((resolve) => setTimeout(resolve, input.retryMs));
    }
  }
}

/** A stop acknowledgement starts settlement; validated terminal receipts join
 * the same terminal observation path as polling and events. */
export async function waitForOwnedRun<T>(input: {
  terminal: Promise<T>;
  stop: () => Promise<unknown>;
  onStopReceipt: (receipt: unknown) => void;
  signal?: AbortSignal;
  timeoutMs: number;
  retryMs: number;
}): Promise<{ terminal: T; timedOut: boolean }> {
  let done = false;
  let timedOut = false;
  let stopping: Promise<void> | undefined;
  let retryTimer: ReturnType<typeof setTimeout> | undefined;
  let wakeStop: (() => void) | undefined;
  const requestStop = () => {
    stopping ??= (async () => {
      while (!done) {
        try {
          const receipt = await input.stop();
          if (!done) input.onStopReceipt(receipt);
        } catch { /* no proof of settlement; retry */ }
        if (done) break;
        await new Promise<void>((resolve) => {
          wakeStop = resolve;
          retryTimer = setTimeout(resolve, input.retryMs);
        });
      }
    })();
  };
  input.signal?.addEventListener("abort", requestStop, { once: true });
  if (input.signal?.aborted) requestStop();
  const timer = input.timeoutMs > 0 ? setTimeout(() => { timedOut = true; requestStop(); }, input.timeoutMs) : undefined;
  try {
    return { terminal: await input.terminal, timedOut };
  } finally {
    done = true;
    clearTimeout(timer);
    clearTimeout(retryTimer);
    wakeStop?.();
    input.signal?.removeEventListener("abort", requestStop);
    await stopping;
  }
}
