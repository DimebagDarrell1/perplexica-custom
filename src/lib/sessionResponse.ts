import SessionManager from './session';

/** Disconnecting a client leaves research available for reconnection. */
export function sessionResponse(
  session: SessionManager,
  signal: AbortSignal,
): Response {
  const encoder = new TextEncoder();
  let disconnect = () => {};
  let closed = false;
  let close = () => {};
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      close = () => {
        if (closed) return;
        closed = true;
        disconnect();
        signal.removeEventListener('abort', close);
        controller.close();
      };
      const send = (data: unknown) =>
        controller.enqueue(encoder.encode(JSON.stringify(data) + '\n'));
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
      disconnect();
      signal.removeEventListener('abort', close);
    },
  });
  return new Response(stream, {
    headers: {
      'Content-Type': 'application/x-ndjson',
      'Cache-Control': 'no-cache, no-transform',
    },
  });
}
