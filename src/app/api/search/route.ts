import ModelRegistry from '@/lib/models/registry';
import { ModelWithProvider } from '@/lib/models/types';
import SessionManager from '@/lib/session';
import { ChatTurnMessage } from '@/lib/types';
import { SearchSources } from '@/lib/agents/search/types';
import APISearchAgent from '@/lib/agents/search/api';

interface ChatRequestBody {
  optimizationMode: 'speed' | 'balanced' | 'quality';
  sources: SearchSources[];
  chatModel: ModelWithProvider;
  embeddingModel: ModelWithProvider;
  query: string;
  history: Array<[string, string]>;
  stream?: boolean;
  useJev?: boolean;
  systemInstructions?: string;
}

export const POST = async (req: Request) => {
  try {
    const body: ChatRequestBody = await req.json();

    if (!body.sources || !body.query) {
      return Response.json(
        { message: 'Missing sources or query' },
        { status: 400 },
      );
    }

    if (body.useJev !== undefined && typeof body.useJev !== 'boolean') {
      return Response.json(
        { message: 'useJev must be a boolean.' },
        { status: 400 },
      );
    }
    body.history = body.history || [];
    body.optimizationMode = body.optimizationMode || 'speed';
    body.stream = body.stream || false;

    const registry = new ModelRegistry();

    const [llm, embeddings] = await Promise.all([
      registry.loadChatModel(body.chatModel.providerId, body.chatModel.key),
      registry.loadEmbeddingModel(
        body.embeddingModel.providerId,
        body.embeddingModel.key,
      ),
    ]);

    const history: ChatTurnMessage[] = body.history.map((msg) => {
      return msg[0] === 'human'
        ? { role: 'user', content: msg[1] }
        : { role: 'assistant', content: msg[1] };
    });

    const session = SessionManager.createSession();

    const agent = new APISearchAgent();

    agent.searchAsync(session, {
      chatHistory: history,
      config: {
        embedding: embeddings,
        llm: llm,
        sources: body.sources,
        mode: body.optimizationMode,
        useJev: body.useJev,
        fileIds: [],
        systemInstructions: body.systemInstructions || '',
      },
      followUp: body.query,
      chatId: crypto.randomUUID(),
      messageId: crypto.randomUUID(),
    });

    if (!body.stream) {
      return await new Promise<Response>((resolve) => {
        let message = '';
        let sources: any[] = [];
        let finished = false;
        let unsubscribe = () => {};
        const finish = (response: Response) => {
          if (finished) return;
          finished = true;
          unsubscribe();
          req.signal.removeEventListener('abort', abort);
          resolve(response);
        };
        const abort = () => {
          session.cancel();
          finish(
            Response.json({ message: 'Request cancelled' }, { status: 499 }),
          );
        };
        unsubscribe = session.subscribe((event, data) => {
          if (finished) return;
          if (event === 'data') {
            if (data.type === 'response') message += data.data;
            else if (data.type === 'searchResults') sources = data.data;
          } else if (event === 'end') {
            finish(Response.json({ message, sources }));
          } else if (event === 'error') {
            finish(
              Response.json(
                { message: 'Search error', error: data },
                { status: 500 },
              ),
            );
          }
        });
        if (finished) unsubscribe();
        else if (req.signal.aborted) abort();
        else req.signal.addEventListener('abort', abort, { once: true });
      });
    }

    const encoder = new TextEncoder();
    let closed = false;
    let unsubscribe = () => {};
    let abort = () => {};
    const cleanup = () => {
      unsubscribe();
      req.signal.removeEventListener('abort', abort);
    };
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        const send = (data: unknown) =>
          controller.enqueue(encoder.encode(JSON.stringify(data) + '\n'));
        const close = () => {
          if (closed) return;
          closed = true;
          cleanup();
          controller.close();
        };
        abort = () => {
          session.cancel();
          close();
        };
        send({ type: 'init', data: 'Stream connected' });
        unsubscribe = session.subscribe((event, data) => {
          if (closed) return;
          if (event === 'data') {
            if (data.type === 'response')
              send({ type: 'response', data: data.data });
            else if (data.type === 'searchResults')
              send({ type: 'sources', data: data.data });
          } else if (event === 'end') {
            send({ type: 'done' });
            close();
          } else if (event === 'error') {
            closed = true;
            cleanup();
            controller.error(data);
          }
        });
        if (closed) cleanup();
        else if (req.signal.aborted) abort();
        else req.signal.addEventListener('abort', abort, { once: true });
      },
      cancel() {
        closed = true;
        cleanup();
        session.cancel();
      },
    });

    return new Response(stream, {
      headers: {
        'Content-Type': 'application/x-ndjson',
        'Cache-Control': 'no-cache, no-transform',
      },
    });
  } catch (err: any) {
    console.error(`Error in getting search results: ${err.message}`);
    return Response.json(
      { message: 'An error has occurred.' },
      { status: 500 },
    );
  }
};
