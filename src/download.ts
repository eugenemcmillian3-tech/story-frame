/** Trigger a real browser download of a text file (used for project-data JSON). */
export function downloadTextFile(
  filename: string,
  text: string,
  mimeType: string = 'application/json',
): void {
  const blob = new Blob([text], { type: `${mimeType};charset=utf-8` });
  const url =
    typeof URL.createObjectURL === 'function'
      ? URL.createObjectURL(blob)
      : `data:${mimeType};charset=utf-8,${encodeURIComponent(text)}`;

  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  anchor.rel = 'noopener';
  anchor.style.display = 'none';
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();

  if (typeof URL.revokeObjectURL === 'function' && url.startsWith('blob:')) {
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
}
