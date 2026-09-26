import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { LocHubApi, type FetchLike } from '../src/api/client';
import { CoverageView } from '../src/reports/CoverageView';
import { InboxView } from '../src/reports/InboxView';
import { missRate, percent } from '../src/reports/summary';
import { SummaryView } from '../src/reports/SummaryView';
import { createFakeApi, makeCell, makeUnit } from './fakeApi';

describe('reports', () => {
  it('computes the blind-audit miss rate and percentages', () => {
    const base = { culture: 'ru', total: 10, byStatus: {}, byBand: { R: 1, Y: 2, G: 7 }, outdated: 0, openQuestions: 0 };
    expect(missRate({ ...base, audit: { sampled: 4, corrected: 1 } })).toBe(0.25);
    expect(missRate({ ...base, audit: { sampled: 0, corrected: 0 } })).toBeUndefined();
    expect(percent(1, 3)).toBe('33%');
    expect(percent(0, 0)).toBe('0%');
  });

  it('lists coverage findings with file and line', async () => {
    const fake = createFakeApi({
      coverage: { pushedAt: '2026-09-25T10:00:00Z', findings: [{ kind: 'FromString', file: 'Source/MyGame/Hud/MyHud.cpp', line: 42, text: 'SPEED' }] },
    });
    render(<CoverageView api={new LocHubApi('', fake.fetch)} />);
    expect(await screen.findByText('Source/MyGame/Hud/MyHud.cpp:42')).toBeTruthy();
    expect(screen.getByText('SPEED')).toBeTruthy();
    expect(screen.getByText('-LEETIFYUnlocalized')).toBeTruthy();
  });

  // The plugin no longer sends a commit sha (LocHub does not depend on git); the last Push's time must still
  // show up on its own, not stay hidden for want of a sha alongside it.
  it('shows the time of the last Push once pushedAt is set, with no sha to go with it', async () => {
    const fake = createFakeApi({
      coverage: { pushedAt: '2026-09-25T10:00:00Z', findings: [] },
    });
    render(<CoverageView api={new LocHubApi('', fake.fetch)} />);
    expect(await screen.findByText(/as reported by the last Push \(2026-09-25T10:00:00Z\)\./)).toBeTruthy();
  });

  it('shows the triage miss rate of a culture', async () => {
    const units = ['A', 'B', 'C', 'D'].map((key) => makeUnit(key, key));
    const cells = Object.fromEntries(
      units.map((unit, i) => [unit.id, makeCell(unit.id, 'ru', { text: 't', status: i === 0 ? 'edited' : 'approved', band: 'G', qaFlags: ['audit'] })]),
    );
    const fake = createFakeApi({ units, cells: { ru: cells } });
    render(<SummaryView api={new LocHubApi('', fake.fetch)} culture="ru" />);
    expect(await screen.findByText(/triage miss rate 25%/)).toBeTruthy();
  });

  it('ignores a stale summary that resolves after a later culture switch', async () => {
    const unit = makeUnit('A', 'A');
    const fake = createFakeApi({
      units: [unit],
      cells: {
        de: { [unit.id]: makeCell(unit.id, 'de', { text: 't', status: 'approved', band: 'G' }) },
        fr: { [unit.id]: makeCell(unit.id, 'fr', { text: 't', status: 'edited', band: 'Y' }) },
      },
    });
    let call = 0;
    let resolveDe: () => void = () => {};
    // Call 1 ("de", the initial render) is slow; call 2 ("fr", after the culture switch) lands first.
    const wrapped: FetchLike = (input, init) => {
      call += 1;
      if (call === 1) {
        return new Promise<Response>((resolve) => {
          resolveDe = () => {
            void fake.fetch(input, init).then(resolve);
          };
        });
      }
      return fake.fetch(input, init);
    };
    const api = new LocHubApi('', wrapped);
    const { rerender } = render(<SummaryView api={api} culture="de" />);
    rerender(<SummaryView api={api} culture="fr" />);
    await screen.findByText('edited');

    resolveDe();
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(screen.queryByText('edited')).toBeTruthy();
    expect(screen.queryByText('approved')).toBeNull();
  });

  it('ignores a stale status-tab response that resolves after a later one', async () => {
    const user = userEvent.setup();
    const fake = createFakeApi({
      units: [],
      inbox: [
        { id: 'q-1', unitId: 'id-x', culture: 'ru', question: 'Answered question', askedBy: 'ai', status: 'answered', answer: 'a', created: 't', answered: 't' },
        { id: 'q-2', unitId: 'id-x', culture: 'ru', question: 'Applied question', askedBy: 'ai', status: 'applied', answer: 'a', created: 't', answered: 't' },
      ],
    });
    let call = 0;
    let resolveAnswered: () => void = () => {};
    // Call 2 ("answered") is a slow network response; call 3 ("applied") is a fast one that lands first.
    const wrapped: FetchLike = (input, init) => {
      call += 1;
      if (call === 2) {
        return new Promise<Response>((resolve) => {
          resolveAnswered = () => {
            void fake.fetch(input, init).then(resolve);
          };
        });
      }
      return fake.fetch(input, init);
    };
    const api = new LocHubApi('', wrapped);
    render(<InboxView api={api} culture="ru" />);
    await screen.findByText('No open questions.');

    await user.click(screen.getByRole('button', { name: 'answered' })); // call 2, paused
    await user.click(screen.getByRole('button', { name: 'applied' })); // call 3, resolves immediately
    await screen.findByText('Applied question');

    resolveAnswered();
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(screen.queryByText('Applied question')).toBeTruthy();
    expect(screen.queryByText('Answered question')).toBeNull();
  });

  it('answers an open question and moves it out of the open list', async () => {
    const user = userEvent.setup();
    const unit = makeUnit('B', 'BACK');
    const fake = createFakeApi({
      units: [unit],
      inbox: [{ id: 'q-1', unitId: unit.id, culture: 'ru', question: 'Button or direction?', askedBy: 'ai', status: 'open', answer: '', created: '2026-09-25T10:00:00Z', answered: '' }],
    });
    render(<InboxView api={new LocHubApi('', fake.fetch)} culture="ru" />);
    expect(await screen.findByText('Button or direction?')).toBeTruthy();
    await user.type(screen.getByLabelText('Answer to q-1'), 'A menu button');
    await user.click(screen.getByRole('button', { name: 'Answer' }));
    await waitFor(() => expect(screen.queryByText('Button or direction?')).toBeNull());
    expect(fake.state.inbox[0]).toMatchObject({ status: 'answered', answer: 'A menu button' });
  });

  it('shows only the questions of the selected culture and follows a culture switch', async () => {
    const unit = makeUnit('B', 'BACK');
    const fake = createFakeApi({
      units: [unit],
      inbox: [
        { id: 'q-1', unitId: unit.id, culture: 'ru', question: 'Russian question', askedBy: 'ai', status: 'open', answer: '', created: 't', answered: '' },
        { id: 'q-2', unitId: unit.id, culture: 'de', question: 'German question', askedBy: 'ai', status: 'open', answer: '', created: 't', answered: '' },
      ],
    });
    const api = new LocHubApi('', fake.fetch);
    const view = render(<InboxView api={api} culture="ru" />);
    expect(await screen.findByText('Russian question')).toBeTruthy();
    expect(screen.queryByText('German question')).toBeNull();

    view.rerender(<InboxView api={api} culture="de" />);
    expect(await screen.findByText('German question')).toBeTruthy();
    expect(screen.queryByText('Russian question')).toBeNull();
  });
});
