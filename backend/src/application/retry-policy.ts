import { HttpError } from '../domain/errors.js';

export const MAX_ATTEMPTS_PER_OPERATION = 3;

export function isRetryableUpstreamFailure(error: unknown): boolean {
  if (!(error instanceof HttpError)) return false;
  return error.code === 'AI_GATEWAY_REQUEST_FAILED'
    || error.code === 'RESEARCH_PROVIDER_REQUEST_FAILED'
    || (error.code === 'UPSTREAM_TEMPORARILY_UNAVAILABLE' && [408, 429, 502, 503, 504].includes(error.statusCode));
}

export async function waitBeforeRetry(milliseconds: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) throw new HttpError(409, 'TASK_EXECUTION_CANCELLED', 'Task execution was cancelled.');
  await new Promise<void>((resolve, reject) => {
    const cleanup = () => signal?.removeEventListener('abort', onAbort);
    const timer = setTimeout(() => { cleanup(); resolve(); }, milliseconds);
    const onAbort = () => {
      clearTimeout(timer);
      cleanup();
      reject(new HttpError(409, 'TASK_EXECUTION_CANCELLED', 'Task execution was cancelled.'));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}
