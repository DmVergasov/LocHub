import { describe, expect, it } from 'vitest';
import { parseView, viewHref } from '../src/route';

describe('hash routes', () => {
  it('parses every view and falls back to the grid', () => {
    expect(parseView('#/card/pt-BR/abc123')).toEqual({ name: 'card', culture: 'pt-BR', unitId: 'abc123' });
    expect(parseView('#/queue')).toEqual({ name: 'queue' });
    expect(parseView('#/inbox')).toEqual({ name: 'inbox' });
    expect(parseView('#/nope')).toEqual({ name: 'grid' });
    expect(parseView('')).toEqual({ name: 'grid' });
    expect(parseView('#/card/%E0%A4%A/x')).toEqual({ name: 'grid' });
  });

  it('round-trips through the href', () => {
    const card = { name: 'card', culture: 'zh-Hans', unitId: 'a/b' } as const;
    expect(parseView(viewHref(card))).toEqual(card);
    expect(viewHref({ name: 'jobs' })).toBe('#/jobs');
  });
});
