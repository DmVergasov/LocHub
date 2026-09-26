import { describe, expect, it } from 'vitest';
import { ApiError } from '../src/api/client';
import { errorText } from '../src/errors';

describe('errorText', () => {
  it('maps codes with no service message to readable English text', () => {
    expect(errorText(new ApiError(409, { error: 'editor_not_connected' }, 'editor_not_connected'))).toBe('The editor is not connected.');
    expect(errorText(new ApiError(409, { error: 'job_running' }, 'job_running'))).toBe('A job for this culture is already running.');
  });

  it('keeps the service message for codes that carry one', () => {
    expect(errorText(new ApiError(422, { error: 'budget', message: 'Estimate $2 is above MaxUSD $1' }, 'Estimate $2 is above MaxUSD $1'))).toBe(
      'Estimate $2 is above MaxUSD $1',
    );
    expect(
      errorText(
        new ApiError(
          409,
          { error: 'files_changed_on_disk', message: 'Localization/LocHub changed on disk since the service loaded it (git pull?). Restart the LocHub service.' },
          'Localization/LocHub changed on disk since the service loaded it (git pull?). Restart the LocHub service.',
        ),
      ),
    ).toBe('Localization/LocHub changed on disk since the service loaded it (git pull?). Restart the LocHub service.');
    expect(
      errorText(
        new ApiError(
          409,
          { error: 'stale_cell', message: 'This string changed since you opened it (new source text or a newer translation). Review it again.' },
          'This string changed since you opened it (new source text or a newer translation). Review it again.',
        ),
      ),
    ).toBe('This string changed since you opened it (new source text or a newer translation). Review it again.');
  });

  it('falls back to the current behaviour for an unknown code', () => {
    expect(errorText(new ApiError(500, { error: 'weird_code' }, 'weird_code'))).toBe('weird_code');
  });

  it('handles a plain Error and a non-error value', () => {
    expect(errorText(new Error('boom'))).toBe('boom');
    expect(errorText('boom')).toBe('boom');
  });
});
