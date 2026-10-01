/** Links in model output and search metadata must not execute browser code. */
export const safeLink = (value: unknown): string | undefined => {
  if (typeof value !== 'string' || /[\u0000-\u0020\u007f]/.test(value))
    return undefined;
  try {
    const url = new URL(value);
    if (
      !['https:', 'http:'].includes(url.protocol) ||
      url.username ||
      url.password
    )
      return undefined;
    return url.href;
  } catch {
    return undefined;
  }
};
