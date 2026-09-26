import { ApiError } from './api/client';

// Codes the service answers with no message of its own; everything else (budget, files_changed_on_disk, stale_cell)
// already carries a service message with the specifics, which ApiError.message prefers (see client.ts `request`).
const CODE_TEXT: Record<string, string> = {
  editor_not_connected: 'The editor is not connected.',
  job_running: 'A job for this culture is already running.',
};

export function errorText(error: unknown): string {
  if (error instanceof ApiError) {
    const code = error.body.error;
    if (code && code in CODE_TEXT) return CODE_TEXT[code]!;
    return error.message;
  }
  if (error instanceof Error) return error.message;
  return String(error);
}
