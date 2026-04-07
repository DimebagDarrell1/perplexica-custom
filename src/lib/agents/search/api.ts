import { ResearcherOutput, SearchAgentInput } from './types';
import SessionManager from '@/lib/session';
import { classify } from './classifier';
import Researcher from './researcher';
import { getWriterPrompt } from '@/lib/prompts/search/writer';
import { WidgetExecutor } from './widgets';
import {
  prepareWriterContext,
  formatWriterContext,
  truncateChatHistory,
} from './writerContext';

class APISearchAgent {
  async searchAsync(session: SessionManager, input: SearchAgentInput) {
    const classification = await classify({
      chatHistory: input.chatHistory,
      enabledSources: input.config.sources,
      query: input.followUp,
      llm: input.config.llm,
    });

    const widgetPromise = WidgetExecutor.executeAll({
      classification,
      chatHistory: input.chatHistory,
      followUp: input.followUp,
      llm: input.config.llm,
    }).catch((err) => {
      console.error(`Error executing widgets: ${err}`);
      return [];
    });

    let searchPromise: Promise<ResearcherOutput> | null = null;

    if (!classification.classification.skipSearch) {
      const researcher = new Researcher();
      searchPromise = researcher.research(SessionManager.createSession(), {
        chatHistory: input.chatHistory,
        followUp: input.followUp,
        classification: classification,
        config: input.config,
      });
    }

    const [widgetOutputs, searchResults] = await Promise.all([
      widgetPromise,
      searchPromise,
    ]);

    // --- Two-stage context pipeline ---
    // Rank → scrape top URLs → select relevant chunks
    const filteredChunks = await prepareWriterContext(
      searchResults?.searchFindings,
      input.followUp,
      classification.standaloneFollowUp,
      input.config.embedding,
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
          content: input.followUp,
        },
      ],
    });

    for await (const chunk of answerStream) {
      session.emit('data', {
        type: 'response',
        data: chunk.contentChunk,
      });
    }

    session.emit('end', {});
  }
}

export default APISearchAgent;
