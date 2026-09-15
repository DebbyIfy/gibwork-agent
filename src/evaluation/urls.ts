const URL_PATTERN = /\bhttps?:\/\/[^\s<>"')]+/gi;
const TRAILING_PUNCTUATION = /[.,;:!?]+$/;

/** Shared by precheck.ts and evidence.ts so URL handling can't drift between them. */
export function extractUrls(text: string): string[] {
  return [...(text ?? '').matchAll(URL_PATTERN)].map((match) => match[0].replace(TRAILING_PUNCTUATION, ''));
}

export function isWellFormedUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return (url.protocol === 'http:' || url.protocol === 'https:') && Boolean(url.hostname);
  } catch {
    return false;
  }
}
