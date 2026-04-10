import BaseEmbedding from '@/lib/models/base/embedding';
import { Chunk } from '@/lib/types';
import { buildFilteredContext, ContextFilterConfig } from './contextFilter';
import type { SearchAgentConfig } from './types';
import UploadStore from '@/lib/uploads/store';

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
  Pick<ContextFilterConfig, 'topKUrls' | 'topKChunks'>
> = {
  speed: {
    topKUrls: 5,
    topKChunks: 15,
  },
  balanced: {
    topKUrls: 10,
    topKChunks: 30,
  },
  quality: {
    topKUrls: 20,
    topKChunks: 60,
  },
};

/**
 * Prepare the filtered writer context from search results.
 *
 * Runs the two-stage context pipeline (rank → scrape → select) and falls back
 * to raw snippets when the pipeline throws **or** when it returns zero chunks
 * despite having received search findings.
 */
export const prepareWriterContext = async (
  searchFindings: Chunk[] | undefined,
  followUp: string,
  standaloneFollowUp: string | undefined,
  embeddingModel: BaseEmbedding<any>,
  mode: SearchAgentConfig['mode'],
): Promise<Chunk[]> => {
  let filteredChunks = searchFindings || [];
  const contextFilterConfig = MODE_CONTEXT_FILTER_CONFIG[mode];

  if (filteredChunks.length > 0) {
    const controller = new AbortController();
    let timeoutId: ReturnType<typeof setTimeout> | undefined;

    try {
      filteredChunks = await Promise.race([
        buildFilteredContext(
          followUp,
          standaloneFollowUp,
          filteredChunks,
          embeddingModel,
          contextFilterConfig,
          controller.signal,
        ),
        new Promise<Chunk[]>((resolve) => {
          timeoutId = setTimeout(() => {
            controller.abort();
            resolve(searchFindings || []);
          }, PIPELINE_TIMEOUT_MS);
        }),
      ]);
    } catch (err) {
      controller.abort();
      console.error(
        '[prepareWriterContext] Context filter pipeline failed, falling back to raw snippets:',
        err,
      );
      filteredChunks = searchFindings || [];
    } finally {
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
      console.warn(
        '[prepareWriterContext] Pipeline returned 0 chunks, falling back to raw snippets',
      );
      filteredChunks = searchFindings;
    }
  }

  return filteredChunks;
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

  if (fileIds.length > 0) {
    try {
      const fileData = UploadStore.getFileData(fileIds);
      uploadedFilesContext = fileData
        .map(
          (file, index) =>
            `<file index="${index + 1}" name="${escapeXml(file.fileName)}">${escapeXml(file.initialContent)}</file>`,
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
          `<file index="${index + 1}" name="${escapeXml(file.fileName)}">${escapeXml(file.initialContent)}</file>`,
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
