import { JSDOM } from 'jsdom';
import { Readability } from '@mozilla/readability';
import TurnDown from 'turndown';

const turndown = new TurnDown();

const normalizeText = (text: string) =>
  text
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();

const isAccessShell = (title: string, text: string) => {
  if (
    !/^(?:just a moment|verify (?:you are )?(?:a )?human|checking your browser|access denied|request blocked|attention required(?: cloudflare)?)$/.test(
      normalizeText(title),
    )
  )
    return false;

  const instructions = [
    /\b(?:please )?(?:enable|turn on) javascript(?: and)? cookies(?: to continue)?\b/g,
    /\b(?:please )?verify (?:that )?(?:you are )?(?:a )?human\b/g,
    /\bchecking (?:your )?browser(?: before (?:accessing|continuing))?\b/g,
    /\bchecking if the site connection is secure\b/g,
    /\b(?:this|the) site needs to review the security of your connection before proceeding\b/g,
    /\b(?:your )?(?:request|access)(?: has been| is)? (?:denied|blocked)\b/g,
    /\byou (?:do not|don t) have permission to access (?:this )?(?:page|website|resource|server)(?: on this server)?\b/g,
  ];
  let remainder = normalizeText(text);
  let hasInstruction = false;
  for (const instruction of instructions) {
    remainder = remainder.replace(instruction, () => {
      hasInstruction = true;
      return ' ';
    });
  }
  if (!hasInstruction) return false;

  // Require only known shell copy so articles discussing these messages survive.
  remainder = remainder
    .replace(/\b(?:just a moment|attention required|access denied)\b/g, ' ')
    .replace(/\b(?:performance and security by )?cloudflare\b/g, ' ')
    .replace(/\bray id [a-f0-9]+\b/g, ' ')
    .replace(/\bplease wait\b/g, ' ');
  return !remainder.trim();
};

/** Extract readable page content without treating page code as evidence. */
export const extractReadableHtml = (html: string, url: string) => {
  const dom = new JSDOM(html, { url });
  try {
    const document = dom.window.document;
    document
      .querySelectorAll('script, style, template, noscript')
      .forEach((node) => node.remove());
    const readable = new Readability(
      document.cloneNode(true) as Document,
    ).parse();
    let root: HTMLElement;
    if (readable?.textContent?.trim() && readable.content) {
      root = document.createElement('div');
      root.innerHTML = readable.content;
    } else {
      root = (
        document.querySelector('main, [role="main"], article') || document.body
      ).cloneNode(true) as HTMLElement;
      root
        .querySelectorAll('nav, [role="navigation"], footer, form, button')
        .forEach((node) => node.remove());
    }
    const content = root.textContent?.trim()
      ? turndown.turndown(root).trim()
      : '';
    if (!content)
      throw new Error('HTML extraction returned no readable content');
    const title =
      document.title.trim() || readable?.title?.trim() || `Content from ${url}`;
    const textNodes: string[] = [];
    const walker = document.createTreeWalker(
      root,
      dom.window.NodeFilter.SHOW_TEXT,
    );
    for (let node = walker.nextNode(); node; node = walker.nextNode())
      textNodes.push(node.textContent || '');
    const text = textNodes.join(' ');
    if (normalizeText(text) === normalizeText(title))
      throw new Error('HTML extraction returned title-only content');
    if (isAccessShell(title, text))
      throw new Error('HTML extraction returned an access challenge shell');
    return { title, content };
  } finally {
    dom.window.close();
  }
};
