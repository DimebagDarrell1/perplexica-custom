import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { loadTs } from './loadTs.mjs';

const Empty = () => null;
const { default: MessageBox } = loadTs('src/components/MessageBox.tsx', {
  '@/lib/hooks/useChat': {
    useChat: () => ({ loading: false, chatHistory: [] }),
  },
  '@/lib/utils': { cn: (...values) => values.filter(Boolean).join(' ') },
  'react-text-to-speech': { useSpeech: () => ({}) },
  './MessageActions/Copy': Empty,
  './MessageActions/Rewrite': Empty,
  './MessageSources': Empty,
  './SearchImages': Empty,
  './SearchVideos': Empty,
  './AssistantSteps': Empty,
  './Widgets/Renderer': Empty,
  './ThinkBox': ({ content }) => React.createElement('aside', {}, content),
  './MessageRenderer/CodeBlock': ({ children }) =>
    React.createElement('pre', {}, children),
});
export function renderAnswer(text, url = 'https://example.com/source') {
  return renderToStaticMarkup(
    React.createElement(MessageBox, {
      sectionIndex: 0,
      isLast: false,
      section: {
        parsedTextBlocks: [text],
        thinkingEnded: true,
        widgets: [],
        message: {
          query: 'Test answer',
          responseBlocks: [
            {
              type: 'source',
              data: [
                { content: 'Evidence', metadata: { url, title: 'Source' } },
              ],
            },
          ],
        },
      },
    }),
  );
}
