import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
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

  describe('AI badge for a Custom endpoint', () => {
    const customAi = (endpoint: AiStatus['endpoint']): AiStatus => ({
      provider: 'custom',
      auth: 'api',
      translateModel: 'qwen3:8b',
      judgeModel: 'qwen3:8b',
      batch: false,
      ready: true,
      detail: 'No API key (not required for a custom endpoint)',
      endpoint,
    });

    async function badgeFor(ai: AiStatus, text: string): Promise<HTMLElement> {
      const fake = createFakeApi({ units: [makeUnit('Pause', 'PAUSED')], ai });
      const api = new LocHubApi('', fake.fetch);
      render(<App api={api} bridge={new EditorBridge(api, () => undefined)} healthMs={60_000} />);
      return screen.findByText(text);
    }

    it('shows the endpoint host, both models and "endpoint OK", with no warning', async () => {
      const badge = await badgeFor(customAi({ url: 'http://127.0.0.1:11434', status: 'ok' }), 'AI: Custom (127.0.0.1:11434) · qwen3:8b / qwen3:8b · endpoint OK');
      expect(badge.className).toBe('ai-status');
      expect(badge.title).toBe('');
    });

    it('shows "checking endpoint…" while the startup probe runs', async () => {
      const badge = await badgeFor(customAi({ url: 'http://127.0.0.1:11434', status: 'checking' }), 'AI: Custom (127.0.0.1:11434) · qwen3:8b / qwen3:8b · checking endpoint…');
      expect(badge.className).toBe('ai-status');
    });

    it('warns about a missing model, with the probe detail as the title', async () => {
      const badge = await badgeFor(
        customAi({ url: 'http://127.0.0.1:11434', status: 'model_missing', detail: 'http://127.0.0.1:11434 does not list qwen3:8b.', missingModels: ['qwen3:8b'] }),
        'AI: Custom (127.0.0.1:11434) · qwen3:8b / qwen3:8b · model missing',
      );
      expect(badge.className).toBe('ai-status warning');
      expect(badge.title).toBe('http://127.0.0.1:11434 does not list qwen3:8b.');
    });

    it('styles only an unreachable endpoint as an error', async () => {
      const badge = await badgeFor(
        customAi({ url: 'https://example.test', status: 'unreachable', detail: 'Cannot reach https://example.test (ECONNREFUSED).' }),
        'AI: Custom (example.test) · qwen3:8b / qwen3:8b · unreachable',
      );
      expect(badge.className).toBe('ai-status endpoint-error');
      expect(badge.title).toBe('Cannot reach https://example.test (ECONNREFUSED).');
    });

    it('shows a server without a model list as neutral "no model list"', async () => {
      const badge = await badgeFor(
        customAi({ url: 'http://127.0.0.1:8080', status: 'unknown', detail: 'http://127.0.0.1:8080 has no model list LocHub can read (GET /models answered HTTP 404).' }),
        'AI: Custom (127.0.0.1:8080) · qwen3:8b / qwen3:8b · no model list',
      );
      expect(badge.className).toBe('ai-status');
    });
  });

  // I-1: a Length Check settings change restarts the service with a different lengthArgs string; that restart
  // resets jobsFinished to 0, so nothing else reloads the grid, and the card's counter (GridRow.lengthLimit,
  // filled by the last GET /api/cells) would otherwise keep the OLD limit forever without a manual Refresh.
  describe('Length Check settings change while a card is open (health.ai.lengthArgs)', () => {
    const COUNTER_TITLE = 'Visible characters / Length Check limit';
    const lengthAi = (lengthArgs: string): AiStatus => ({
      provider: 'anthropic',
      auth: 'api',
      translateModel: 'claude-opus-5-5',
      judgeModel: 'claude-sonnet-5',
      batch: true,
      ready: true,
      detail: '',
      lengthArgs,
    });

    afterEach(() => {
      window.location.hash = '#/grid';
    });

    it('follows the limit to the card counter when lengthArgs changes, then hides the counter once Length Check turns off — all without Refresh', async () => {
      const unit = makeUnit('Bales', '{Count} bales left');
      const fake = createFakeApi({
        // 'Осталось {Count} тюков' is 15 visible characters (the argument counts 0).
        units: [unit],
        cells: { ru: { [unit.id]: makeCell(unit.id, 'ru', { text: 'Осталось {Count} тюков', status: 'ai_draft', band: 'Y' }) } },
        ai: lengthAi('--length-check warning --length-scope ui --length-ratio 1.30 --length-extra 4'),
      });
      fake.state.lengthLimits = { [unit.id]: 20 };
      const api = new LocHubApi('', fake.fetch);
      window.location.hash = `#/card/ru/${unit.id}`;
      render(<App api={api} bridge={new EditorBridge(api, () => undefined)} healthMs={20} />);

      await waitFor(() => expect(screen.getByTitle(COUNTER_TITLE).textContent).toBe('15/20'));

      // Length Check settings changed (a new ratio/limit); the editor restarted the service with them, so
      // lengthArgs — and the limit GET /api/cells now sends for this string — both changed.
      fake.state.lengthLimits = { [unit.id]: 10 };
      fake.state.ai = lengthAi('--length-check warning --length-scope ui --length-ratio 1.30 --length-extra 8');

      await waitFor(() => expect(screen.getByTitle(COUNTER_TITLE).textContent).toBe('15/10'), { timeout: 5000 });
      expect(screen.getByTitle(COUNTER_TITLE).className).toBe('length-counter over');

      // Length Check turned off entirely: the limit is now null, so the counter disappears — "never enabled"
      // means no highlight at all, not merely no "over" class.
      fake.state.lengthLimits = { [unit.id]: null };
      fake.state.ai = lengthAi('--length-check off');

      await waitFor(() => expect(screen.queryByTitle(COUNTER_TITLE)).toBeNull(), { timeout: 5000 });
    }, 10000);

    it('does not reload on the very first poll, even when lengthArgs already has a value', async () => {
      const unit = makeUnit('Bales', '{Count} bales left');
      const fake = createFakeApi({
        units: [unit],
        cells: { ru: { [unit.id]: makeCell(unit.id, 'ru', { text: 'Осталось {Count} тюков', status: 'ai_draft', band: 'Y' }) } },
        ai: lengthAi('--length-check warning --length-scope ui --length-ratio 1.30 --length-extra 4'),
      });
      fake.state.lengthLimits = { [unit.id]: 20 };
      const api = new LocHubApi('', fake.fetch);
      window.location.hash = `#/card/ru/${unit.id}`;
      render(<App api={api} bridge={new EditorBridge(api, () => undefined)} healthMs={20} />);
      await screen.findByTitle(COUNTER_TITLE);

      const cellCallsBefore = fake.calls.filter((c) => c.startsWith('GET /api/cells')).length;
      await waitFor(() => expect(fake.calls.filter((c) => c === 'GET /api/health').length).toBeGreaterThanOrEqual(3), { timeout: 5000 });
      expect(fake.calls.filter((c) => c.startsWith('GET /api/cells')).length).toBe(cellCallsBefore);
    }, 10000);
  });
});
