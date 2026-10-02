import { abortable } from '@/lib/utils/cancellation';
import { CancellableLLM, CancellableEmbedding } from '@/lib/models/cancellable';
import { SearchAgentInput } from './types';
import SessionManager from '@/lib/session';
import { classify } from './classifier';
import Researcher from './researcher';
import { getWriterPrompt } from '@/lib/prompts/search/writer';
import { WidgetExecutor } from './widgets';
import {
  prepareWriterContext,
  formatWriterContext,
  truncateChatHistory,
  buildWriterUserMessage,
} from './writerContext';

class APISearchAgent {
  async searchAsync(session: SessionManager, input: SearchAgentInput) {
    input = {
      ...input,
      config: {
        ...input.config,
        sources: input.config.sources.includes('web')
          ? input.config.sources
          : [...input.config.sources, 'web'],
        llm: new CancellableLLM(input.config.llm, session.signal),
        embedding: new CancellableEmbedding(
          input.config.embedding,
          session.signal,
        ),
      },
    };
    try {
      const classification = await classify({
        chatHistory: input.chatHistory,
        enabledSources: input.config.sources,
        query: input.followUp,
        llm: input.config.llm,
      });

      const widgetPromise = abortable(
        () =>
          WidgetExecutor.executeAll({
            classification,
            chatHistory: input.chatHistory,
            followUp: input.followUp,
            llm: input.config.llm,
            signal: session.signal,
          }),
        session.signal,
      ).catch((err) => {
        console.error(`Error executing widgets: ${err}`);
        return [];
      });

      const researcher = new Researcher();
      const searchPromise = abortable(
        () =>
          researcher.research(session, {
            chatHistory: input.chatHistory,
            followUp: input.followUp,
            classification,
            config: input.config,
          }),
        session.signal,
      );

      const [widgetOutputs, searchResults] = await Promise.all([
        widgetPromise,
        searchPromise,
      ]);

      // --- Two-stage context pipeline ---
      // Rank -> scrape top URLs -> select relevant chunks
      const filteredChunks = await prepareWriterContext(
        searchResults?.searchFindings,
        input.followUp,
        classification.standaloneFollowUp,
        input.config.embedding,
        input.config.mode,
        session.signal,
        input.config.fileIds.length > 0,
        input.config.useJev !== false,
      );

      if (searchResults) {
        session.emit('data', {
          type: 'searchResults',
          data: filteredChunks,
        });
      }

      session.emit('data', {
        type: 'researchComplete',
      });

      const finalContextWithWidgets = formatWriterContext(
        filteredChunks,
        widgetOutputs,
        input.config.fileIds,
      );

      const writerPrompt = getWriterPrompt(
        finalContextWithWidgets,
        input.config.systemInstructions,
        input.config.mode,
      );

      const truncatedHistory = truncateChatHistory(input.chatHistory);

      const answerStream = input.config.llm.streamText({
        messages: [
          {
            role: 'system',
            content: writerPrompt,
          },
          ...truncatedHistory,
          {
            role: 'user',
            content: buildWriterUserMessage(
              input.followUp,
              input.config.fileIds,
            ),
          },
        ],
      });

      for await (const chunk of answerStream) {
        session.emit('data', {
          type: 'response',
          data: chunk.contentChunk,
        });
      }

      session.signal.throwIfAborted();
      session.emit('end', {});
    } catch (err) {
      console.error('API search agent error:', err);

      session.emit('error', {
        data:
          err instanceof Error
            ? err.message
            : 'An error occurred during search',
      });
    }
  }
}

export default APISearchAgent;
