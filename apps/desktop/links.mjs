/** Only web links may leave the sandboxed renderer for the system browser. */
export function externalWebLink(value) {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && !url.username && !url.password ? url.href : null;
  } catch {
    return null;
  }
}
