/**
 * Client-side text download utility.
 * No backend, no storage — pure Blob + anchor click.
 *
 * @param {string} text    - Raw text content to save
 * @param {'md'|'txt'} ext - File extension (default 'md')
 */
export function downloadText(text, ext = 'md') {
  if (!text) return;
  const now = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  const stamp = [
    now.getFullYear(),
    pad(now.getMonth() + 1),
    pad(now.getDate()),
  ].join('-') + '-' + [
    pad(now.getHours()),
    pad(now.getMinutes()),
    pad(now.getSeconds()),
  ].join('');
  const filename = `ai-response-${stamp}.${ext}`;
  const mime = ext === 'md' ? 'text/markdown' : 'text/plain';
  const blob = new Blob([text], { type: `${mime};charset=utf-8` });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}
