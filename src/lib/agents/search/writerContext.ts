import type { JevRerankResult } from '@/lib/jev';
import { CancellableEmbedding } from '@/lib/models/cancellable';
import { truncateTokens } from '@/lib/utils/splitText';
import { abortable } from '@/lib/utils/cancellation';
import BaseEmbedding from '@/lib/models/base/embedding';
import { Chunk } from '@/lib/types';
import {
  buildFilteredContext,
  ContextFilterConfig,
  type ContextFilterCheckpoint,
} from './contextFilter';
import { selectFallbackSnippets } from './fallbackEvidence';
import type { SearchAgentConfig } from './types';
import UploadStore from '@/lib/uploads/store';
import {
  dedupeEvidenceChunks,
  dedupeSearchResults,
  groupEvidenceBySource,
  MODE_SEARCH_LIMITS,
} from './resultUtils';

/** Maximum number of chat history messages to include in the writer LLM call. */
export const MAX_CHAT_HISTORY_MESSAGES = 20;

/** Maximum time (ms) the context filter pipeline may run before falling back. */
const PIPELINE_TIMEOUT_MS = 45_000;

const escapeXml = (value: unknown): string =>
  String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');

const MODE_CONTEXT_FILTER_CONFIG: Record<
  SearchAgentConfig['mode'],
  Pick<
    ContextFilterConfig,
    'topKUrls' | 'topKChunks' | 'maxCandidateResults' | 'preferFirecrawl'
  >
> = {
  speed: {
    topKUrls: 3,
    topKChunks: 15,
    maxCandidateResults: MODE_SEARCH_LIMITS.speed.maxCandidateResults,
    preferFirecrawl: false,
  },
  balanced: {
    topKUrls: 10,
    topKChunks: 30,
    maxCandidateResults: MODE_SEARCH_LIMITS.balanced.maxCandidateResults,
    preferFirecrawl: true,
  },
  quality: {
    topKUrls: 20,
    topKChunks: 60,
    maxCandidateResults: MODE_SEARCH_LIMITS.quality.maxCandidateResults,
    preferFirecrawl: true,
  },
};

const prepareFallbackChunks = (
  chunks: Chunk[],
  limit: number,
  query: string,
): Chunk[] => {
  const uploads = dedupeEvidenceChunks(
    chunks.filter((chunk) =>
      String(chunk.metadata.url || '').startsWith('file_id://'),
    ),
  );
  const web = selectFallbackSnippets(
    query,
    dedupeSearchResults(
      chunks.filter(
        (chunk) => !String(chunk.metadata.url || '').startsWith('file_id://'),
      ),
    ),
  );

  const uploadLimit = web.length ? Math.max(1, Math.floor(limit / 3)) : limit;
  const selectedUploads = uploads.slice(0, uploadLimit);
  return groupEvidenceBySource([
    ...selectedUploads,
    ...web.slice(0, limit - selectedUploads.length),
  ]);
};

/**
 * Prepare the filtered writer context from search results.
 *
 * Retain completed ranking and page reads when context processing times out.
 * Use snippet recovery only when no completed stage is available.
 */
export const prepareWriterContext = async (
  searchFindings: Chunk[] | undefined,
  followUp: string,
  standaloneFollowUp: string | undefined,
  embeddingModel: BaseEmbedding<any>,
  mode: SearchAgentConfig['mode'],
  signal?: AbortSignal,
  hasUploadedFiles = false,
  useJev = true,
): Promise<Chunk[]> => {
  signal?.throwIfAborted();
  let filteredChunks = searchFindings || [];
  let reranking: JevRerankResult | undefined;
  let contextFallback = false;
  let recoveryReason: 'timeout' | 'failure' | 'empty' | undefined;
  let checkpoint: ContextFilterCheckpoint | undefined;
  let progressOpen = true;
  const contextFilterConfig = {
    ...MODE_CONTEXT_FILTER_CONFIG[mode],
    useJev: useJev && mode !== 'speed' && !hasUploadedFiles,
    onJevResult: (result: JevRerankResult) => {
      reranking = result;
    },
    onProgress: (progress: ContextFilterCheckpoint) => {
      if (progressOpen && progress.chunks.length) checkpoint = progress;
    },
  };
  const fallbackLimit = MODE_SEARCH_LIMITS[mode].fallbackContextChunks;
  const recoverEvidence = () =>
    checkpoint?.chunks.length
      ? checkpoint.chunks
      : prepareFallbackChunks(
          searchFindings || [],
          fallbackLimit,
          standaloneFollowUp?.trim() || followUp,
        );

  if (filteredChunks.length > 0) {
    const controller = new AbortController();
    const pipelineSignal = signal
      ? AbortSignal.any([controller.signal, signal])
      : controller.signal;
    let timeoutId: ReturnType<typeof setTimeout> | undefined;

    try {
      filteredChunks = await Promise.race([
        abortable(
          () =>
            buildFilteredContext(
              followUp,
              standaloneFollowUp,
              filteredChunks,
              new CancellableEmbedding(embeddingModel, pipelineSignal),
              contextFilterConfig,
              pipelineSignal,
            ),
          pipelineSignal,
        ),
        new Promise<Chunk[]>((resolve) => {
          timeoutId = setTimeout(
            () => {
              contextFallback = true;
              recoveryReason = 'timeout';
              progressOpen = false;
              resolve(recoverEvidence());
              controller.abort();
            },
            mode === 'speed' ? 15_000 : PIPELINE_TIMEOUT_MS,
          );
        }),
      ]);
    } catch (err) {
      contextFallback = true;
      recoveryReason ||= 'failure';
      progressOpen = false;
      controller.abort();
      signal?.throwIfAborted();
      console.error(
        '[prepareWriterContext] Context processing stopped; retaining available evidence:',
        err,
      );
      filteredChunks = recoverEvidence();
    } finally {
      progressOpen = false;
      if (timeoutId) {
        clearTimeout(timeoutId);
      }
    }

    // If the pipeline returned zero chunks but we had findings, fall back
    // so the writer LLM always receives some context.
    if (
      filteredChunks.length === 0 &&
      searchFindings &&
      searchFindings.length > 0
    ) {
      contextFallback = true;
      recoveryReason = 'empty';
      console.warn(
        '[prepareWriterContext] Pipeline returned no evidence; using recovery evidence',
      );
      filteredChunks = recoverEvidence();
    }
  }

  signal?.throwIfAborted();
  const evidence = groupEvidenceBySource(
    dedupeEvidenceChunks(filteredChunks).slice(
      0,
      contextFilterConfig.topKChunks,
    ),
  );
  if (contextFallback) {
    console.log(
      JSON.stringify({
        event: 'research_context_recovery',
        reason: recoveryReason,
        stage: checkpoint?.stage || 'unranked',
        contextMode: checkpoint?.contextMode || 'snippets',
        citationSources: evidence.length,
        completedPageSources: evidence.filter(
          (chunk) => chunk.metadata.extractionProvider,
        ).length,
        jevRetained: checkpoint?.jevUsed === true,
      }),
    );
  }
  const tokenBudget = { speed: 8000, balanced: 16000, quality: 32000 }[mode];
  return evidence.map((chunk) => ({
    ...chunk,
    metadata: {
      ...chunk.metadata,
      contextMode:
        checkpoint?.contextMode || (contextFallback ? 'snippets' : 'filtered'),
      contextRecovery: contextFallback
        ? checkpoint?.stage || 'unranked'
        : undefined,
      jev: {
        requested: useJev,
        status: !useJev
          ? 'off'
          : hasUploadedFiles
            ? 'skipped'
            : mode === 'speed'
              ? 'skipped'
              : reranking?.status || 'not-run',
        reason: hasUploadedFiles
          ? 'uploaded_files'
          : mode === 'speed'
            ? 'speed_mode'
            : reranking?.reason,
        used:
          reranking?.status === 'applied' &&
          (!contextFallback || checkpoint?.jevUsed === true),
        candidateCount: reranking?.candidateCount || 0,
        durationMs: reranking?.durationMs || 0,
      },
    },
    content: truncateTokens(
      chunk.content,
      Math.floor(tokenBudget / evidence.length),
    ),
  }));
};

/**
 * Format filtered chunks and widget outputs into the combined XML context
 * string consumed by the writer prompt.
 */
export const formatWriterContext = (
  filteredChunks: Chunk[],
  widgetOutputs: { llmContext: string }[],
  fileIds: string[] = [],
): string => {
  const hasUploadedFileContext = filteredChunks.some((chunk) =>
    String(chunk.metadata.url || '').startsWith('file_id://'),
  );

  let uploadedFilesContext = '';

  const representedFiles = new Set(
    filteredChunks.map((chunk) =>
      String(chunk.metadata.url || '').replace(/^file_id:\/\//, ''),
    ),
  );
  const missingFileIds = [...new Set(fileIds)].filter(
    (id) => !representedFiles.has(id),
  );
  if (missingFileIds.length > 0) {
    try {
      const fileData = UploadStore.getFileData(missingFileIds);
      uploadedFilesContext = fileData
        .map(
          (file, index) =>
            `<file index="${index + 1}" name="${escapeXml(file.fileName)}">${escapeXml(truncateTokens(file.initialContent, Math.max(1, Math.floor(3000 / fileData.length))))}</file>`,
        )
        .join('\n');
    } catch (error) {
      console.error(
        '[formatWriterContext] Failed to load uploaded file excerpts:',
        error,
      );
    }
  }

  const searchContext = filteredChunks
    .map((f, index) => {
      const isUploadedFile = String(f.metadata.url || '').startsWith(
        'file_id://',
      );
      const sourceName = isUploadedFile
        ? f.metadata.fileName || f.metadata.title || 'Uploaded File'
        : f.metadata.url || f.metadata.title || 'Web Source';

      return `<result index="${index + 1}" source_type="${isUploadedFile ? 'uploaded_file' : 'web'}" title="${escapeXml(f.metadata.title)}" source_name="${escapeXml(sourceName)}" url="${escapeXml(f.metadata.url || '')}">${escapeXml(f.content)}</result>`;
    })
    .join('\n');

  const widgetContext = widgetOutputs
    .map((o) => `<result>${escapeXml(o.llmContext)}</result>`)
    .join('\n-------------\n');

  return `<uploaded_files noteForAssistant="${uploadedFilesContext ? 'These are direct excerpts from files the user attached in this chat. Treat them as primary user-provided document context and use them when answering.' : 'No uploaded file excerpts were loaded.'}">\n${uploadedFilesContext}\n</uploaded_files>\n<search_results note="${hasUploadedFileContext ? 'These results include excerpts from user-uploaded files. If any result has source_type=&quot;uploaded_file&quot;, the user DID attach a file in this chat. Use those excerpts as document context and do not claim that no file was attached.' : 'These are the search results and assistant can cite these.'}">\n${searchContext}\n</search_results>\n<widgets_result noteForAssistant="Its output is already showed to the user, assistant can use this information to answer the query but do not CITE this as a souce">\n${widgetContext}\n</widgets_result>`;
};

export const buildWriterUserMessage = (
  followUp: string,
  fileIds: string[] = [],
): string => {
  if (fileIds.length === 0) {
    return followUp;
  }

  try {
    const fileData = UploadStore.getFileData(fileIds);
    const uploadedFilesContext = fileData
      .map(
        (file, index) =>
          `<file index="${index + 1}" name="${escapeXml(file.fileName)}"></file>`,
      )
      .join('\n');

    return `<attached_files_present>true</attached_files_present>
<attached_files note="These files were attached by the user in this chat. Use them directly when answering and do not claim that no file was attached.">
${uploadedFilesContext}
</attached_files>
<user_question>
${escapeXml(followUp)}
</user_question>`;
  } catch (error) {
    console.error(
      '[buildWriterUserMessage] Failed to load uploaded file excerpts:',
      error,
    );
    return followUp;
  }
};

/**
 * Truncate chat history to the most recent messages, preventing unbounded
 * context growth in the writer LLM call.
 */
export const truncateChatHistory = <T>(chatHistory: T[]): T[] =>
  chatHistory.slice(-MAX_CHAT_HISTORY_MESSAGES);
