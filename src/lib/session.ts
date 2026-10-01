import { EventEmitter } from 'stream';
import { applyPatch } from 'rfc6902';
import { Block } from './types';

const sessions =
  (global as any)._sessionManagerSessions || new Map<string, SessionManager>();
if (process.env.NODE_ENV !== 'production') {
  (global as any)._sessionManagerSessions = sessions;
}

class SessionManager {
  private static sessions: Map<string, SessionManager> = sessions;
  readonly id: string;
  private controller = new AbortController();
  private finished = false;
  get signal() {
    return this.controller.signal;
  }
  cancel() {
    if (!this.finished)
      this.controller.abort(new DOMException('Stopped by user', 'AbortError'));
  }
  private blocks = new Map<string, Block>();
  private events: { event: string; data: any }[] = [];
  private emitter = new EventEmitter();
  private TTL_MS = 30 * 60 * 1000;

  constructor(id?: string) {
    this.id = id ?? crypto.randomUUID();

    setTimeout(() => {
      this.cancel();
      SessionManager.sessions.delete(this.id);
    }, this.TTL_MS).unref();
  }

  static getSession(id: string): SessionManager | undefined {
    return this.sessions.get(id);
  }

  static getAllSessions(): SessionManager[] {
    return Array.from(this.sessions.values());
  }

  static createSession(): SessionManager {
    const session = new SessionManager();
    this.sessions.set(session.id, session);
    return session;
  }

  removeAllListeners() {
    this.emitter.removeAllListeners();
  }

  emit(event: string, data: any) {
    if (this.finished || (this.signal.aborted && event === 'data')) return;
    if (event === 'end' || event === 'error') this.finished = true;
    // Block snapshots already hold the latest state; retaining every growing
    // text patch would make replay memory grow with the square of the answer.
    if (event !== 'data' || !['block', 'updateBlock'].includes(data?.type)) {
      this.events.push({ event, data: structuredClone(data) });
    }
    if (event !== 'error' || this.emitter.listenerCount('error') > 0) {
      this.emitter.emit(event, data);
    }
  }

  emitBlock(block: Block) {
    if (this.finished || this.signal.aborted) return;
    this.blocks.set(block.id, block);
    this.emit('data', {
      type: 'block',
      block: block,
    });
  }

  getBlock(blockId: string): Block | undefined {
    return this.blocks.get(blockId);
  }

  updateBlock(blockId: string, patch: any[]) {
    if (this.finished || this.signal.aborted) return;
    const block = this.blocks.get(blockId);

    if (block) {
      applyPatch(block, patch);
      this.blocks.set(blockId, block);
      this.emit('data', {
        type: 'updateBlock',
        blockId: blockId,
        patch: patch,
      });
    }
  }

  getAllBlocks() {
    return structuredClone(Array.from(this.blocks.values()));
  }

  subscribe(listener: (event: string, data: any) => void): () => void {
    const replay = [
      ...this.getAllBlocks().map((block) => ({
        event: 'data',
        data: { type: 'block', block },
      })),
      ...structuredClone(this.events),
    ];

    const handler = (event: string) => (data: any) => listener(event, data);
    const dataHandler = handler('data');
    const endHandler = handler('end');
    const errorHandler = handler('error');

    this.emitter.on('data', dataHandler);
    this.emitter.on('end', endHandler);
    this.emitter.on('error', errorHandler);

    for (const { event, data } of replay) listener(event, data);

    return () => {
      this.emitter.off('data', dataHandler);
      this.emitter.off('end', endHandler);
      this.emitter.off('error', errorHandler);
    };
  }
}

export default SessionManager;
