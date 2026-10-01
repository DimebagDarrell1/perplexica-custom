import { RuleType } from 'markdown-to-jsx';

// Returning a string lets React show raw HTML without interpreting it.
const literalNode = (node: any): string => {
  if (typeof node === 'string') return node;
  if (node.type === RuleType.htmlComment) return '';
  if (typeof node.text === 'string' && !node.tag) return node.text;
  const children = Array.isArray(node.children)
    ? node.children.map(literalNode).join('')
    : node.text || '';
  if (!node.tag) return children;
  const attrs = Object.entries(node.attrs || {})
    .map(
      ([key, value]) =>
        ` ${key}="${typeof value === 'object' ? JSON.stringify(value) : String(value)}"`,
    )
    .join('');
  return node.type === RuleType.htmlSelfClosing
    ? `<${node.tag}${attrs} />`
    : `<${node.tag}${attrs}>${children}</${node.tag}>`;
};

export const safeHtmlLiteral = (node: any): string | undefined => {
  if (
    ![
      RuleType.htmlBlock,
      RuleType.htmlSelfClosing,
      RuleType.htmlComment,
    ].includes(node.type)
  )
    return undefined;
  const attrs = Object.keys(node.attrs || {});
  if (node.tag === 'think' && attrs.length === 0) return undefined;
  if (
    node.tag === 'citation' &&
    attrs.length === 1 &&
    attrs[0] === 'index' &&
    /^[1-9]\d*$/.test(String(node.attrs.index))
  )
    return undefined;
  // Used by the existing streaming reasoning-block parser.
  if (
    node.tag === 'a' &&
    attrs.length === 0 &&
    literalNode(node)
      .replace(/<\/?a>/g, '')
      .trim() === ''
  )
    return '';
  return literalNode(node);
};
