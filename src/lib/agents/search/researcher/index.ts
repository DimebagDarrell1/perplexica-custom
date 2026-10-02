import { ActionOutput, ResearcherInput, ResearcherOutput } from '../types';
import { ActionRegistry } from './actions';
import { getResearcherPrompt } from '@/lib/prompts/search/researcher';
import SessionManager from '@/lib/session';
import { Message, ReasoningResearchBlock } from '@/lib/types';
import formatChatHistoryAsString from '@/lib/utils/formatHistory';
import { ToolCall } from '@/lib/models/types';
import { limitChunksForMode } from '../resultUtils';

class Researcher {
  async research(
    session: SessionManager,
    input: ResearcherInput,
  ): Promise<ResearcherOutput> {
    session.signal.throwIfAborted();
    input = {
      ...input,
      classification: {
        ...input.classification,
        classification: {
          ...input.classification.classification,
          skipSearch: false,
        },
      },
      config: {
        ...input.config,
        sources: input.config.sources.includes('web')
          ? input.config.sources
          : [...input.config.sources, 'web'],
      },
    };
    let actionOutput: ActionOutput[] = [];
    let maxIteration =
      input.config.mode === 'speed'
        ? 2
        : input.config.mode === 'balanced'
          ? 6
          : 25;

    const availableTools = ActionRegistry.getAvailableActionTools({
      classification: input.classification,
      fileIds: input.config.fileIds,
      mode: input.config.mode,
      sources: input.config.sources,
    });

    const availableActionsDescription =
      ActionRegistry.getAvailableActionsDescriptions({
        classification: input.classification,
        fileIds: input.config.fileIds,
        mode: input.config.mode,
        sources: input.config.sources,
      });

    const researchBlockId = crypto.randomUUID();

    session.emitBlock({
      id: researchBlockId,
      type: 'research',
      data: {
        subSteps: [],
      },
    });

    const agentMessageHistory: Message[] = [
      {
        role: 'user',
        content: `
          <conversation>
          ${formatChatHistoryAsString(input.chatHistory.slice(-10))}
           User: ${input.followUp} (Standalone question: ${input.classification.standaloneFollowUp})
          </conversation>
        `,
      },
    ];

    const webToolCall: ToolCall = {
      id: crypto.randomUUID(),
      name: 'web_search',
      arguments: {
        queries: [
          input.classification.standaloneFollowUp?.trim() || input.followUp,
        ],
      },
    };
    agentMessageHistory.push({
      role: 'assistant',
      content: null,
      tool_calls: [webToolCall],
    });
    const webAction = await ActionRegistry.execute(
      webToolCall.name,
      webToolCall.arguments,
      {
        llm: input.config.llm,
        embedding: input.config.embedding,
        session,
        mode: input.config.mode,
        researchBlockId,
        fileIds: input.config.fileIds,
        requireSearchSuccess: true,
      },
    );
    session.signal.throwIfAborted();
    actionOutput.push(webAction);
    agentMessageHistory.push({
      role: 'tool',
      id: webToolCall.id,
      name: webToolCall.name,
      content: JSON.stringify(webAction),
    });

    if (input.config.fileIds.length > 0) {
      const uploadQueries = Array.from(
        new Set(
          [
            input.classification.standaloneFollowUp,
            input.followUp,
            `summary ${input.followUp}`,
          ]
            .map((query) => query?.trim())
            .filter((query): query is string => !!query),
        ),
      ).slice(0, 3);

      if (uploadQueries.length > 0) {
        const uploadToolCall: ToolCall = {
          id: crypto.randomUUID(),
          name: 'uploads_search',
          arguments: {
            queries: uploadQueries,
          },
        };

        agentMessageHistory.push({
          role: 'assistant',
          content: null,
          tool_calls: [uploadToolCall],
        });

        const uploadAction = await ActionRegistry.execute(
          uploadToolCall.name,
          uploadToolCall.arguments,
          {
            llm: input.config.llm,
            embedding: input.config.embedding,
            session,
            mode: input.config.mode,
            researchBlockId,
            fileIds: input.config.fileIds,
          },
        );

        actionOutput.push(uploadAction);

        agentMessageHistory.push({
          role: 'tool',
          id: uploadToolCall.id,
          name: uploadToolCall.name,
          content: JSON.stringify(uploadAction),
        });
      }
    }

    // The required first web search uses one research iteration.
    for (let i = 1; i < maxIteration; i++) {
      session.signal.throwIfAborted();
      const researcherPrompt = getResearcherPrompt(
        availableActionsDescription,
        input.config.mode,
        i,
        maxIteration,
        input.config.fileIds,
      );

      const actionStream = input.config.llm.streamText({
        messages: [
          {
            role: 'system',
            content: researcherPrompt,
          },
          ...agentMessageHistory,
        ],
        tools: availableTools,
      });

      const block = session.getBlock(researchBlockId);

      let reasoningEmitted = false;
      let reasoningId = crypto.randomUUID();

      let finalToolCalls: ToolCall[] = [];

      for await (const partialRes of actionStream) {
        if (partialRes.toolCallChunk.length > 0) {
          partialRes.toolCallChunk.forEach((tc) => {
            if (
              tc.name === '__reasoning_preamble' &&
              tc.arguments['plan'] &&
              !reasoningEmitted &&
              block &&
              block.type === 'research'
            ) {
              reasoningEmitted = true;

              block.data.subSteps.push({
                id: reasoningId,
                type: 'reasoning',
                reasoning: tc.arguments['plan'],
              });

              session.updateBlock(researchBlockId, [
                {
                  op: 'replace',
                  path: '/data/subSteps',
                  value: block.data.subSteps,
                },
              ]);
            } else if (
              tc.name === '__reasoning_preamble' &&
              tc.arguments['plan'] &&
              reasoningEmitted &&
              block &&
              block.type === 'research'
            ) {
              const subStepIndex = block.data.subSteps.findIndex(
                (step: any) => step.id === reasoningId,
              );

              if (subStepIndex !== -1) {
                const subStep = block.data.subSteps[
                  subStepIndex
                ] as ReasoningResearchBlock;
                subStep.reasoning = tc.arguments['plan'];
                session.updateBlock(researchBlockId, [
                  {
                    op: 'replace',
                    path: '/data/subSteps',
                    value: block.data.subSteps,
                  },
                ]);
              }
            }

            const existingIndex = finalToolCalls.findIndex(
              (ftc) => ftc.id === tc.id,
            );

            if (existingIndex !== -1) {
              finalToolCalls[existingIndex].arguments = tc.arguments;
            } else {
              finalToolCalls.push(tc);
            }
          });
        }
      }

      if (finalToolCalls.length === 0) {
        break;
      }

      const finished = finalToolCalls.some((call) => call.name === 'done');
      session.signal.throwIfAborted();

      agentMessageHistory.push({
        role: 'assistant',
        content: null,
        tool_calls: finalToolCalls,
      });

      const actionResults = await ActionRegistry.executeAll(finalToolCalls, {
        llm: input.config.llm,
        embedding: input.config.embedding,
        session: session,
        mode: input.config.mode,
        researchBlockId: researchBlockId,
        fileIds: input.config.fileIds,
      });

      session.signal.throwIfAborted();
      actionOutput.push(...actionResults);
      if (finished) break;

      actionResults.forEach((action, i) => {
        agentMessageHistory.push({
          role: 'tool',
          id: finalToolCalls[i].id,
          name: finalToolCalls[i].name,
          content: JSON.stringify(action),
        });
      });
    }

    const searchResults = actionOutput
      .filter((a) => a.type === 'search_results')
      .flatMap((a) => a.results);

    const filteredSearchResults = limitChunksForMode(
      searchResults,
      input.config.mode,
    );

    const sourceBlockId = crypto.randomUUID();

    session.emitBlock({
      id: sourceBlockId,
      type: 'source',
      data: filteredSearchResults,
    });

    return {
      findings: actionOutput,
      searchFindings: filteredSearchResults,
      sourceBlockId,
    };
  }
}

export default Researcher;
