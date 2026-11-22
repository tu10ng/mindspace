const MARKER_RE = /UNIQUE_[A-Z0-9_]+/;
export const EXEC_SUMMARY_PREFIX = '执行摘要标记:';

export function corpusMarkerOf(prompt: string): string {
  return MARKER_RE.exec(prompt)?.[0] ?? '';
}

export function requireCorpusMarker(prompt: string, action: string): string {
  const marker = corpusMarkerOf(prompt);
  if (marker === '') {
    throw new Error(`mock contract violated: ${action} request does not contain the unique corpus text marker`);
  }
  return marker;
}

export function requireExecutionSummaryMarker(prompt: string, action: string): void {
  if (!prompt.includes(EXEC_SUMMARY_PREFIX) || corpusMarkerOf(prompt) === '') {
    throw new Error(`mock contract violated: ${action} request does not contain the unique execution summary marker or the input corpus marker`);
  }
}
