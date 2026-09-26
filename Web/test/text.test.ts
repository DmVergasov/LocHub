import { describe, expect, it } from 'vitest';
import { formatArgs } from '../src/text';

describe('formatArgs', () => {
  it('lists format arguments once and skips backtick-escaped braces', () => {
    expect(formatArgs('{Count} bales left, {Count}|plural(one=bale,other=bales) for {Player}')).toEqual(['Count', 'Player']);
    expect(formatArgs('Use `{literal} braces')).toEqual([]);
    expect(formatArgs('PAUSED')).toEqual([]);
  });
});
