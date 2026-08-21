const MAX_ERROR_BODY_LENGTH = 180;

function responseLabel(response: Response): string {
  const statusText = response.statusText.trim();
  return `HTTP ${response.status}${statusText ? ` ${statusText}` : ''}`;
}

function bodyPreview(body: string): string {
  const compact = body.replace(/\s+/g, ' ').trim();
  if (!compact) return '';
  return compact.length > MAX_ERROR_BODY_LENGTH
    ? `${compact.slice(0, MAX_ERROR_BODY_LENGTH)}…`
    : compact;
}

function errorMessage(value: unknown): string | null {
  if (!value || typeof value !== 'object' || !('error' in value)) return null;
  const error = (value as { error?: unknown }).error;
  return typeof error === 'string' && error.trim() ? error.trim() : null;
}

/**
 * Parse an API response without masking a plain-text/HTML HTTP failure as a
 * JSON.parse exception. Next may emit "Internal Server Error" before a route
 * handler runs, so callers must inspect the raw body and HTTP status first.
 */
export async function readJsonResponse<T>(response: Response): Promise<T> {
  const body = await response.text();
  let parsed: unknown;

  try {
    parsed = JSON.parse(body);
  } catch {
    const preview = bodyPreview(body);
    const detail = preview ? `：${preview}` : '：伺服器沒有回傳內容';
    throw new Error(`${responseLabel(response)}，回應不是 JSON${detail}`);
  }

  if (!response.ok) {
    throw new Error(errorMessage(parsed) ?? responseLabel(response));
  }

  return parsed as T;
}
