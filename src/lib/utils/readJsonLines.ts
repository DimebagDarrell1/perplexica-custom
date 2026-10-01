/** Keep incomplete lines buffered without replaying already-delivered events. */
export async function readJsonLines(
  body: ReadableStream<Uint8Array>,
  onMessage: (message: any) => void | Promise<void>,
) {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let pending = '';
  try {
    while (true) {
      const { value, done } = await reader.read();
      pending += done
        ? decoder.decode()
        : decoder.decode(value, { stream: true });
      let end: number;
      while ((end = pending.indexOf('\n')) >= 0) {
        const line = pending.slice(0, end);
        pending = pending.slice(end + 1);
        if (line.trim()) await onMessage(JSON.parse(line));
      }
      if (done) {
        if (pending.trim()) await onMessage(JSON.parse(pending));
        return;
      }
    }
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}
