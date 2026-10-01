/** Abort waiting even when a local computation cannot be interrupted. */
export function abortable<T>(
  work: () => Promise<T>,
  signal: AbortSignal,
): Promise<T> {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const cancel = () => reject(signal.reason);
    signal.addEventListener('abort', cancel, { once: true });
    Promise.resolve()
      .then(() => {
        signal.throwIfAborted();
        return work();
      })
      .then(
        (value) => {
          signal.removeEventListener('abort', cancel);
          resolve(value);
        },
        (error) => {
          signal.removeEventListener('abort', cancel);
          reject(error);
        },
      );
  });
}

export async function* abortableStream<T>(
  work: AsyncGenerator<T>,
  signal: AbortSignal,
): AsyncGenerator<T> {
  try {
    while (true) {
      const next = await abortable(() => work.next(), signal);
      if (next.done) return;
      signal.throwIfAborted();
      yield next.value;
    }
  } finally {
    // A local generator may still be computing. Do not hold cancellation open.
    void work.return(undefined as never).catch(() => {});
  }
}

export function fetchWithSignal(signal: AbortSignal): typeof fetch {
  return (input, init) =>
    fetch(input, {
      ...init,
      signal: AbortSignal.any([signal, ...(init?.signal ? [init.signal] : [])]),
    });
}
