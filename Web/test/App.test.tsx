import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';
import { LocHubApi } from '../src/api/client';
import { App, editorStatus } from '../src/App';
import type { AiStatus } from '../src/api/types';
import { EditorBridge } from '../src/bridge';
import { createFakeApi, makeCell, makeUnit } from './fakeApi';

describe('App', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('loads the cultures, shows the grid and reports an offline editor', async () => {
    const unit = makeUnit('Pause', 'PAUSED');
    const fake = createFakeApi({ units: [unit], cells: { ru: { [unit.id]: makeCell(unit.id, 'ru', { text: 'ПАУЗА', status: 'approved' }) } } });
    const api = new LocHubApi('', fake.fetch);
    render(<App api={api} bridge={new EditorBridge(api, () => undefined)} healthMs={60_000} />);
    expect(await screen.findByText('ПАУЗА')).toBeTruthy();
    expect(await screen.findByText('Editor: offline')).toBeTruthy();
    expect((screen.getByLabelText('Culture') as HTMLSelectElement).value).toBe('ru');

    // A culture not set up in the project must not be displayable: no way to add one.
    expect(within(screen.getByLabelText('Culture')).getAllByRole('option').map((option) => option.textContent)).toEqual(['ru']);
    expect(screen.queryByLabelText('Add culture')).toBeNull();
  });

  it('offers only the project cultures (meta.cultures) in the culture select, sorted', async () => {
    const unit = makeUnit('Pause', 'PAUSED');
    const fake = createFakeApi({
      units: [unit],
      cells: { ru: { [unit.id]: makeCell(unit.id, 'ru', { text: 'ПАУЗА', status: 'approved' }) }, de: {}, fr: {} },
    });
    const api = new LocHubApi('', fake.fetch);
    render(<App api={api} bridge={new EditorBridge(api, () => undefined)} healthMs={60_000} />);
    await screen.findByText('Pause');

    expect(within(screen.getByLabelText('Culture')).getAllByRole('option').map((option) => option.textContent)).toEqual(['de', 'fr', 'ru']);
    expect(screen.queryByLabelText('Add culture')).toBeNull();
  });

  it('shows guidance to set up cultures and push when the project has none yet', async () => {
    const fake = createFakeApi();
    const api = new LocHubApi('', fake.fetch);
    render(<App api={api} bridge={new EditorBridge(api, () => undefined)} healthMs={60_000} />);
    const empty = await screen.findByText(/^No strings yet\./);
    expect(empty.textContent).toContain('Tools > LocHub > Set Up Localization Target');
    expect(empty.textContent).toContain('press Push');
  });

  const aiStatus = (ready: boolean, detail: string) => ({
    provider: 'anthropic' as const, auth: 'api' as const, translateModel: 'claude-opus-5-5', judgeModel: 'claude-sonnet-5',
    batch: true, ready, detail,
  });

  it('shows the provider problem as a visible banner, not only as a tooltip', async () => {
    const fake = createFakeApi({
      units: [makeUnit('Pause', 'PAUSED')],
      ai: aiStatus(false, 'ANTHROPIC_API_KEY is not set: set it before starting the editor, then restart the editor.'),
    });
    const api = new LocHubApi('', fake.fetch);
    render(<App api={api} bridge={new EditorBridge(api, () => undefined)} healthMs={60_000} />);
    const banner = await screen.findByRole('alert');
    expect(banner.textContent).toContain('ANTHROPIC_API_KEY is not set');
  });

  it('shows the plugin logo next to the product name', async () => {
    const fake = createFakeApi({ units: [makeUnit('Pause', 'PAUSED')] });
    const api = new LocHubApi('', fake.fetch);
    const { container } = render(<App api={api} bridge={new EditorBridge(api, () => undefined)} healthMs={60_000} />);
    await screen.findByText(/^AI: Anthropic/);
    const logo = container.querySelector('.brand img');
    expect(logo?.getAttribute('src')).toBe('./favicon.svg');
    expect(logo?.closest('.brand')?.textContent?.trim()).toBe('LocHub');
  });

  it('shows no provider banner when the provider is ready', async () => {
    const fake = createFakeApi({ units: [makeUnit('Pause', 'PAUSED')], ai: aiStatus(true, 'ANTHROPIC_API_KEY is set') });
    const api = new LocHubApi('', fake.fetch);
    render(<App api={api} bridge={new EditorBridge(api, () => undefined)} healthMs={60_000} />);
    await screen.findByText(/^AI: Anthropic/);
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('shows a banner when the store is stale, and Refresh re-reads meta', async () => {
    const unit = makeUnit('Pause', 'PAUSED');
    const fake = createFakeApi({ units: [unit], cells: { ru: { [unit.id]: makeCell(unit.id, 'ru', { text: 'ПАУЗА', status: 'approved' }) } }, stale: true });
    const api = new LocHubApi('', fake.fetch);
    render(<App api={api} bridge={new EditorBridge(api, () => undefined)} healthMs={60_000} />);

    expect(await screen.findByText(/Localization\/LocHub changed on disk/)).toBeTruthy();
    const metaCallsBefore = fake.calls.filter((call) => call === 'GET /api/meta').length;
    fireEvent.click(screen.getByRole('button', { name: 'Refresh' }));
    await waitFor(() => expect(fake.calls.filter((call) => call === 'GET /api/meta').length).toBeGreaterThan(metaCallsBefore));
  });

  it('names every editor state', () => {
    const health = { ok: true, units: 1, editorConnected: true, stale: false };
    expect(editorStatus(undefined, 'none')).toBe('Service offline');
    expect(editorStatus(health, 'direct')).toBe('Editor: this tab');
    expect(editorStatus(health, 'relay')).toBe('Editor: connected');
    expect(editorStatus(health, 'none')).toBe('Editor: offline');
  });

  it('shows the provider, auth and models in the AI badge when ready', async () => {
    const unit = makeUnit('Pause', 'PAUSED');
    const fake = createFakeApi({
      units: [unit],
      ai: { provider: 'openai', auth: 'api', translateModel: 'gpt-6-sol', judgeModel: 'gpt-6-luna', batch: false, ready: true, detail: 'OPENAI_API_KEY is set' },
    });
    const api = new LocHubApi('', fake.fetch);
    render(<App api={api} bridge={new EditorBridge(api, () => undefined)} healthMs={60_000} />);
    const badge = await screen.findByText('AI: OpenAI · gpt-6-sol / gpt-6-luna');
    expect(badge.className).not.toContain('warning');
  });

  it('marks the subscription auth in the badge, with a warning and title when not ready', async () => {
    const unit = makeUnit('Pause', 'PAUSED');
    const fake = createFakeApi({
      units: [unit],
      ai: {
        provider: 'anthropic',
        auth: 'subscription',
        translateModel: 'claude-opus-5-5',
        judgeModel: 'claude-sonnet-5',
        batch: false,
        ready: false,
        detail: 'Claude Code is not signed in: run "claude" once and sign in.',
      },
    });
    const api = new LocHubApi('', fake.fetch);
    render(<App api={api} bridge={new EditorBridge(api, () => undefined)} healthMs={60_000} />);
    const badge = await screen.findByText('AI: Anthropic (subscription) · claude-opus-5-5 / claude-sonnet-5');
    expect(badge.className).toContain('warning');
    expect(badge.title).toBe('Claude Code is not signed in: run "claude" once and sign in.');
  });

  it('shows AI: Anthropic without a warning when an older service sends no ai block', async () => {
    const unit = makeUnit('Pause', 'PAUSED');
    const fake = createFakeApi({ units: [unit] });
    const api = new LocHubApi('', fake.fetch);
    render(<App api={api} bridge={new EditorBridge(api, () => undefined)} healthMs={60_000} />);
    const badge = await screen.findByText('AI: Anthropic');
    expect(badge.className).not.toContain('warning');
  });

  it('shows AI: Anthropic, not "AI: undefined", when the service sends the previous ai shape (no provider)', async () => {
    const unit = makeUnit('Pause', 'PAUSED');
    // The pre-provider ai shape: {backend, ready, detail}, no `provider`/`translateModel`/`judgeModel`. Cast past
    // the current AiStatus type since this mimics an older service's actual reply, not a value this app ever builds.
    const oldShapeAi = { backend: 'anthropic', ready: true, detail: '' } as unknown as AiStatus;
    const fake = createFakeApi({ units: [unit], ai: oldShapeAi });
    const api = new LocHubApi('', fake.fetch);
    render(<App api={api} bridge={new EditorBridge(api, () => undefined)} healthMs={60_000} />);
    const badge = await screen.findByText('AI: Anthropic');
    expect(badge.className).not.toContain('warning');
    expect(screen.queryByText(/undefined/)).toBeNull();
  });

  it('names the review queue "Review" and shows how many strings wait in it', async () => {
    const red = makeUnit('Red', 'RED');
    const green = makeUnit('Green', 'GREEN');
    const fake = createFakeApi({
      units: [red, green],
      cells: {
        de: {
          [red.id]: makeCell(red.id, 'de', { text: 'ROT', status: 'ai_draft', band: 'R' }),
          [green.id]: makeCell(green.id, 'de', { text: 'GRUEN', status: 'ai_draft', band: 'G' }),
        },
      },
    });
    const api = new LocHubApi('', fake.fetch);
    render(<App api={api} bridge={new EditorBridge(api, () => undefined)} healthMs={60_000} />);
    expect(await screen.findByRole('link', { name: 'Review (1)' })).toBeTruthy();
    expect(screen.queryByRole('link', { name: /^Queue/ })).toBeNull();
  });

  describe('culture columns', () => {
    it('shows only the active column by default; checking a culture adds it and survives a remount; switching the active culture adds it too', async () => {
      const pause = makeUnit('Pause', 'PAUSED');
      const fake = createFakeApi({
        units: [pause],
        cells: { de: {}, fr: {}, ru: { [pause.id]: makeCell(pause.id, 'ru', { text: 'ПАУЗА', status: 'approved' }) } },
      });
      const api = new LocHubApi('', fake.fetch);
      const bridge = new EditorBridge(api, () => undefined);

      const first = render(<App api={api} bridge={bridge} healthMs={60_000} />);
      await screen.findByText('Pause');
      expect((screen.getByLabelText('Culture') as HTMLSelectElement).value).toBe('de');
      let header = document.querySelector('.grid-header') as HTMLElement;
      expect(within(header).getByText('de')).toBeTruthy();
      expect(within(header).queryByText('fr')).toBeNull();
      expect(within(header).queryByText('ru')).toBeNull();

      fireEvent.click(screen.getByRole('button', { name: 'Columns' }));
      fireEvent.click(within(screen.getByRole('dialog', { name: 'Columns' })).getByRole('checkbox', { name: 'fr' }));
      header = document.querySelector('.grid-header') as HTMLElement;
      expect(within(header).getByText('de')).toBeTruthy();
      expect(within(header).getByText('fr')).toBeTruthy();
      expect(within(header).queryByText('ru')).toBeNull();
      expect(localStorage.getItem('lochub.gridExtraColumns')).toBe(JSON.stringify(['fr']));

      first.unmount();

      render(<App api={api} bridge={bridge} healthMs={60_000} />);
      await screen.findByText('Pause');
      header = document.querySelector('.grid-header') as HTMLElement;
      expect(within(header).getByText('de')).toBeTruthy();
      expect(within(header).getByText('fr')).toBeTruthy();
      expect(within(header).queryByText('ru')).toBeNull();

      fireEvent.change(screen.getByLabelText('Culture'), { target: { value: 'ru' } });
      header = document.querySelector('.grid-header') as HTMLElement;
      expect(within(header).getByText('ru')).toBeTruthy();
      expect(within(header).getByText('fr')).toBeTruthy();
      // The previous active culture was never picked in Columns, so it must not stay behind as a column.
      expect(within(header).queryByText('de')).toBeNull();
    });
  });

  describe('sync (Push / Dry run / Pull)', () => {
    function deferred<T>() {
      let resolve!: (value: T) => void;
      let reject!: (reason?: unknown) => void;
      const promise = new Promise<T>((res, rej) => {
        resolve = res;
        reject = rej;
      });
      return { promise, resolve, reject };
    }

    it('hides the buttons when the binding has no sync', async () => {
      const unit = makeUnit('Pause', 'PAUSED');
      const fake = createFakeApi({ units: [unit], cells: { ru: { [unit.id]: makeCell(unit.id, 'ru', { text: 'ПАУЗА', status: 'approved' }) } } });
      const api = new LocHubApi('', fake.fetch);
      render(<App api={api} bridge={new EditorBridge(api, () => undefined)} healthMs={60_000} />);
      await screen.findByText('ПАУЗА');
      expect(screen.queryByRole('button', { name: 'Push' })).toBeNull();
      expect(screen.queryByRole('button', { name: 'Dry run' })).toBeNull();
      expect(screen.queryByRole('button', { name: 'Pull' })).toBeNull();
    });

    it('disables all three while one runs, shows the summary when it resolves, reveals details, and reloads meta after a successful push', async () => {
      const unit = makeUnit('Pause', 'PAUSED');
      const fake = createFakeApi({ units: [unit], cells: { ru: { [unit.id]: makeCell(unit.id, 'ru', { text: 'ПАУЗА', status: 'approved' }) } } });
      const api = new LocHubApi('', fake.fetch);
      const sync = deferred<string>();
      const binding = { openorigin: () => true, setpreviewculture: () => true, applylive: () => true, sync: () => sync.promise };
      render(<App api={api} bridge={new EditorBridge(api, () => binding)} healthMs={60_000} />);
      await screen.findByText('ПАУЗА');

      const metaCallsBefore = fake.calls.filter((call) => call === 'GET /api/meta').length;
      fireEvent.click(screen.getByRole('button', { name: 'Push' }));

      const pushBtn = screen.getByRole('button', { name: 'Pushing…' }) as HTMLButtonElement;
      const dryBtn = screen.getByRole('button', { name: 'Dry run' }) as HTMLButtonElement;
      const pullBtn = screen.getByRole('button', { name: 'Pull' }) as HTMLButtonElement;
      expect(pushBtn.disabled).toBe(true);
      expect(dryBtn.disabled).toBe(true);
      expect(pullBtn.disabled).toBe(true);

      sync.resolve(JSON.stringify({ success: true, cancelled: false, summary: 'Pushed 3 strings.', details: ['A added', 'B changed'] }));
      await waitFor(() => expect(screen.getByRole('button', { name: 'Push' })).toBeTruthy());

      const status = screen.getByRole('status');
      expect(status.className).toContain('sync-result');
      expect(status.className).toContain('ok');
      expect(within(status).getByText('Pushed 3 strings.')).toBeTruthy();

      fireEvent.click(within(status).getByText('Details'));
      expect(within(status).getByText('A added')).toBeTruthy();
      expect(within(status).getByText('B changed')).toBeTruthy();

      await waitFor(() => expect(fake.calls.filter((call) => call === 'GET /api/meta').length).toBeGreaterThan(metaCallsBefore));

      fireEvent.click(within(status).getByRole('button', { name: 'Dismiss' }));
      expect(screen.queryByRole('status')).toBeNull();
    });

    it('shows a failed outcome, including one from a thrown error, as failed', async () => {
      const unit = makeUnit('Pause', 'PAUSED');
      const fake = createFakeApi({ units: [unit], cells: { ru: { [unit.id]: makeCell(unit.id, 'ru', { text: 'ПАУЗА', status: 'approved' }) } } });
      const api = new LocHubApi('', fake.fetch);
      const binding = { openorigin: () => true, setpreviewculture: () => true, applylive: () => true, sync: () => Promise.reject(new Error('Editor is busy.')) };
      render(<App api={api} bridge={new EditorBridge(api, () => binding)} healthMs={60_000} />);
      await screen.findByText('ПАУЗА');

      fireEvent.click(screen.getByRole('button', { name: 'Pull' }));
      await waitFor(() => expect(screen.getByRole('status')).toBeTruthy());
      const status = screen.getByRole('status');
      expect(status.className).toContain('sync-result');
      expect(status.className).toContain('failed');
      expect(within(status).getByText('Editor is busy.')).toBeTruthy();
    });
  });

  describe('job finished while another tab is open (health.jobsFinished)', () => {
    // jobRunning true->false is invisible to a client whose poll misses a job shorter than one
    // poll interval — jobRunning simply never observes 'true'. jobsFinished (a monotonic counter) catches this:
    // a later poll reporting a larger value than the last one seen reloads, with no jobRunning transition at all.
    it('reloads the grid when a later poll reports a larger jobsFinished, with jobRunning never observed true', async () => {
      const unit = makeUnit('Pause', 'PAUSED');
      const fake = createFakeApi({ units: [unit], cells: { ru: { [unit.id]: makeCell(unit.id, 'ru', { text: 'OLD', status: 'approved' }) } } });
      fake.state.jobsFinished = 3; // an established baseline before the component ever polls
      const api = new LocHubApi('', fake.fetch);
      render(<App api={api} bridge={new EditorBridge(api, () => undefined)} healthMs={20} />);
      expect(await screen.findByText('OLD')).toBeTruthy();

      const cellCallsBeforeJob = fake.calls.filter((c) => c.startsWith('GET /api/cells')).length;
      // Change the cell as a real job would while it runs, then bump the counter without ever setting
      // jobRunning: true — the job started and finished between two polls.
      fake.state.cells.ru = { ...fake.state.cells.ru, [unit.id]: makeCell(unit.id, 'ru', { text: 'NEW', status: 'approved' }) };
      fake.state.jobsFinished = 4;

      // No Refresh click: the grid must pick up 'NEW' on its own once health reports a larger jobsFinished.
      expect(await screen.findByText('NEW', {}, { timeout: 5000 })).toBeTruthy();
      expect(fake.calls.filter((c) => c.startsWith('GET /api/cells')).length).toBeGreaterThan(cellCallsBeforeJob);
      expect(fake.state.jobRunning).toBe(false); // never touched: proves the old jobRunning latch is not what fired
    }, 10000);

    it('does not reload on the very first poll, even when jobsFinished already reports a nonzero value', async () => {
      const unit = makeUnit('Pause', 'PAUSED');
      const fake = createFakeApi({ units: [unit], cells: { ru: { [unit.id]: makeCell(unit.id, 'ru', { text: 'ПАУЗА', status: 'approved' }) } } });
      fake.state.jobsFinished = 7;
      const api = new LocHubApi('', fake.fetch);
      render(<App api={api} bridge={new EditorBridge(api, () => undefined)} healthMs={20} />);
      await screen.findByText('ПАУЗА');

      const cellCallsBefore = fake.calls.filter((c) => c.startsWith('GET /api/cells')).length;
      await waitFor(() => expect(fake.calls.filter((c) => c === 'GET /api/health').length).toBeGreaterThanOrEqual(3), { timeout: 5000 });
      expect(fake.calls.filter((c) => c.startsWith('GET /api/cells')).length).toBe(cellCallsBefore);
    }, 10000);

    it('never reloads from an absent jobsFinished field (an older service), or while health is entirely absent', async () => {
      const unit = makeUnit('Pause', 'PAUSED');
      const fake = createFakeApi({ units: [unit], cells: { ru: { [unit.id]: makeCell(unit.id, 'ru', { text: 'ПАУЗА', status: 'approved' }) } } });
      // jobsFinished left undefined throughout: the fake omits the field entirely, like a service that predates it.
      let healthShouldFail = false;
      const wrappedFetch: typeof fake.fetch = async (input, init) => {
        if (healthShouldFail && new URL(input, 'http://lochub.test').pathname === '/api/health') return { ok: false, status: 500, text: async () => '' } as Response;
        return fake.fetch(input, init);
      };
      const api = new LocHubApi('', wrappedFetch);
      render(<App api={api} bridge={new EditorBridge(api, () => undefined)} healthMs={20} />);
      await screen.findByText('ПАУЗА');

      const cellCallsBefore = fake.calls.filter((c) => c.startsWith('GET /api/cells')).length;
      await waitFor(() => expect(fake.calls.filter((c) => c === 'GET /api/health').length).toBeGreaterThanOrEqual(3), { timeout: 5000 });
      expect(fake.calls.filter((c) => c.startsWith('GET /api/cells')).length).toBe(cellCallsBefore);

      // Health polls that fail entirely (health becomes undefined) must not trigger a reload either.
      healthShouldFail = true;
      await new Promise((resolve) => setTimeout(resolve, 200));
      expect(fake.calls.filter((c) => c.startsWith('GET /api/cells')).length).toBe(cellCallsBefore);
    }, 10000);
  });

  describe('grid scroll memory', () => {
    // Enough rows that .grid-scroll actually has somewhere to scroll to (jsdom gives it a 600px box, see setup.ts).
    function manyUnits(count: number) {
      return Array.from({ length: count }, (_, i) => makeUnit(`K${i}`, `Source ${i}`));
    }

    function renderManyRowGrid() {
      const units = manyUnits(60);
      const cells = { ru: Object.fromEntries(units.map((unit, i) => [unit.id, makeCell(unit.id, 'ru', { text: `Translated ${i}`, status: 'approved' })])) };
      const fake = createFakeApi({ units, cells });
      const api = new LocHubApi('', fake.fetch);
      render(<App api={api} bridge={new EditorBridge(api, () => undefined)} healthMs={60_000} />);
      return api;
    }

    it('keeps the grid scrolled to the same position after a card visit and after visiting another tab', async () => {
      renderManyRowGrid();
      await screen.findByText('60 of 60 strings');

      const scroller = document.querySelector('.grid-scroll') as HTMLElement;
      scroller.scrollTop = 700;
      fireEvent.scroll(scroller);

      const cellButtons = [...document.querySelectorAll('.grid-row .cell')];
      const firstCell = cellButtons[0];
      expect(firstCell).toBeTruthy();
      fireEvent.click(firstCell!);
      expect(await screen.findByText('Back to the grid')).toBeTruthy();

      // Back to the grid (hashchange, same as clicking the "Back to the grid" link or the browser Back button):
      // GridView remounts, and the scroll position must not have reset to the top.
      window.location.hash = '#/grid';
      fireEvent(window, new Event('hashchange'));
      await screen.findByText('60 of 60 strings');
      let restored = document.querySelector('.grid-scroll') as HTMLElement;
      expect(restored.scrollTop).toBe(700);

      // A trip to another tab and back keeps it too.
      window.location.hash = '#/jobs';
      fireEvent(window, new Event('hashchange'));
      window.location.hash = '#/grid';
      fireEvent(window, new Event('hashchange'));
      await screen.findByText('60 of 60 strings');
      restored = document.querySelector('.grid-scroll') as HTMLElement;
      expect(restored.scrollTop).toBe(700);
    });
  });
});
