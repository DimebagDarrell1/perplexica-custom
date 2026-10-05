import SessionManager from './session';

/** Proxies such as nginx close responses that stay silent for about 60 s. */
export const KEEP_ALIVE_MS = 15_000;

/** Disconnecting a client leaves research available for reconnection. */
export function sessionResponse(
  session: SessionManager,
  signal: AbortSignal,
  keepAliveMs = KEEP_ALIVE_MS,
): Response {
  const encoder = new TextEncoder();
  let disconnect = () => {};
  let closed = false;
  let close = () => {};
  let keepAlive: ReturnType<typeof setInterval> | undefined;
  const stopKeepAlive = () => {
    if (keepAlive) clearInterval(keepAlive);
    keepAlive = undefined;
  };
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      let lastWrite = Date.now();
      close = () => {
        if (closed) return;
        closed = true;
        stopKeepAlive();
        disconnect();
        signal.removeEventListener('abort', close);
        controller.close();
      };
      const send = (data: unknown) => {
        lastWrite = Date.now();
        controller.enqueue(encoder.encode(JSON.stringify(data) + '\n'));
      };
      // Long reasoning or page reads can leave the stream quiet. Clients
      // ignore this message type.
      keepAlive = setInterval(() => {
        if (!closed && Date.now() - lastWrite >= keepAliveMs)
          send({ type: 'keepAlive' });
      }, keepAliveMs);
      keepAlive.unref?.();
      send({ type: 'session', id: session.id });
      disconnect = session.subscribe((event, data) => {
        if (closed) return;
        if (event === 'data') send(data);
        else {
          send(
            event === 'end'
              ? { type: 'messageEnd', ...data }
              : { type: 'error', data: data.data },
          );
          close();
        }
      });
      // subscribe replays synchronously and may close before returning cleanup.
      if (closed) disconnect();
      else if (signal.aborted) close();
      else signal.addEventListener('abort', close, { once: true });
    },
    cancel() {
      closed = true;
      stopKeepAlive();
      disconnect();
      signal.removeEventListener('abort', close);
    },
  });
  return new Response(stream, {
    headers: {
      'Content-Type': 'application/x-ndjson',
      'Cache-Control': 'no-cache, no-transform',
      // Stops nginx-based proxies such as SWAG from buffering the stream.
      'X-Accel-Buffering': 'no',
    },
  });
}
