import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { LocHubApi } from '../src/api/client';
import type { JobEstimate } from '../src/api/types';
import type { GridRow } from '../src/grid/model';
import { JobsView } from '../src/jobs/JobsView';
import { createFakeApi, makeCell, makeUnit } from './fakeApi';

function groupedRow(key: string, groupKey: string, status: GridRow['cells'][string]['cell']['status'] = 'empty'): GridRow {
  const unit = makeUnit(key, `${key} source`, { groupKey });
  return { unit, cells: { ru: { cell: makeCell(unit.id, 'ru', { status }), outdated: false } } };
}

describe('JobsView', () => {
  it('estimates, refuses a budget below the estimate, runs and reports', async () => {
    const user = userEvent.setup();
    const fake = createFakeApi({ units: [makeUnit('A', 'PAUSED'), makeUnit('B', 'BACK')], estimateUsd: 0.5, jobPolls: 1 });
    const onJobDone = vi.fn();
    render(<JobsView api={new LocHubApi('', fake.fetch)} culture="ru" onJobDone={onJobDone} pollMs={5} />);

    await user.click(screen.getByRole('button', { name: 'Estimate' }));
    expect(await screen.findByText(/estimated \$0\.50/)).toBeTruthy();
    const maxUsd = screen.getByLabelText('Max USD') as HTMLInputElement;
    expect(maxUsd.value).toBe('0.60');

    await user.clear(maxUsd);
    await user.type(maxUsd, '0.4');
    expect((screen.getByRole('button', { name: 'Run' }) as HTMLButtonElement).disabled).toBe(true);

    await user.clear(maxUsd);
    await user.type(maxUsd, '1');
    await user.click(screen.getByRole('button', { name: 'Run' }));
    expect(await screen.findByText('Job done')).toBeTruthy();
    await waitFor(() => expect(onJobDone).toHaveBeenCalledTimes(1));
    expect(screen.getByText(/Written 2/)).toBeTruthy();
    expect(fake.calls).toContain('POST /api/jobs');
  });

  it('uses the preset selection from a glossary fix', async () => {
    const user = userEvent.setup();
    const fake = createFakeApi({ units: [makeUnit('A', 'PAUSED'), makeUnit('B', 'BACK')] });
    render(<JobsView api={new LocHubApi('', fake.fetch)} culture="ru" preset={{ culture: 'ru', unitIds: ['id-A'] }} onJobDone={vi.fn()} pollMs={5} />);
    expect(screen.getByText(/1 selected string/)).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Estimate' }));
    expect(await screen.findByText(/^1 strings in 1 requests/)).toBeTruthy();
  });

  it('resets estimate when culture changes', async () => {
    const user = userEvent.setup();
    const fake = createFakeApi({ units: [makeUnit('A', 'PAUSED')] });
    const { rerender } = render(
      <JobsView api={new LocHubApi('', fake.fetch)} culture="ru" onJobDone={vi.fn()} pollMs={5} />,
    );
    await user.click(screen.getByRole('button', { name: 'Estimate' }));
    expect(await screen.findByText(/estimated \$0\.50/)).toBeTruthy();

    rerender(<JobsView api={new LocHubApi('', fake.fetch)} culture="de" onJobDone={vi.fn()} pollMs={5} />);
    expect(screen.queryByText(/estimated \$0\.50/)).not.toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Run' })).not.toBeTruthy();
  });

  it('prevents double-click on Run button', async () => {
    const user = userEvent.setup();
    const fake = createFakeApi({ units: [makeUnit('A', 'PAUSED')], estimateUsd: 0.5, jobPolls: 2 });
    render(<JobsView api={new LocHubApi('', fake.fetch)} culture="ru" onJobDone={vi.fn()} pollMs={50} />);
    await user.click(screen.getByRole('button', { name: 'Estimate' }));
    expect(await screen.findByText(/estimated \$0\.50/)).toBeTruthy();

    const maxUsd = screen.getByLabelText('Max USD') as HTMLInputElement;
    await user.clear(maxUsd);
    await user.type(maxUsd, '1');

    const runButton = screen.getByRole('button', { name: 'Run' }) as HTMLButtonElement;
    user.click(runButton);
    user.click(runButton);

    await waitFor(() => {
      expect(fake.calls.filter((call) => call.includes('POST /api/jobs')).length).toBe(1);
    });
  });

  it('stops polling and shows error when poll fails', async () => {
    const user = userEvent.setup();
    const fake = createFakeApi({ units: [makeUnit('A', 'PAUSED')], estimateUsd: 0.5, jobPolls: 1 });

    // Wrap the fake fetch to inject a 404 after first successful poll
    let pollCount = 0;
    const wrappedFetch: typeof fake.fetch = async (input, init) => {
      const url = new URL(input, 'http://lochub.test');
      if (url.pathname.match(/^\/api\/jobs\/job-\d+$/)) {
        pollCount++;
        if (pollCount > 1) {
          return {
            ok: false,
            status: 404,
            text: async () => JSON.stringify({ error: 'Unknown job' }),
          } as Response;
        }
      }
      return fake.fetch(input, init);
    };

    render(<JobsView api={new LocHubApi('', wrappedFetch)} culture="ru" onJobDone={vi.fn()} pollMs={5} />);
    await user.click(screen.getByRole('button', { name: 'Estimate' }));
    expect(await screen.findByText(/estimated \$0\.50/)).toBeTruthy();

    const maxUsd = screen.getByLabelText('Max USD') as HTMLInputElement;
    await user.clear(maxUsd);
    await user.type(maxUsd, '1');
    await user.click(screen.getByRole('button', { name: 'Run' }));

    expect(await screen.findByText(/Job running/)).toBeTruthy();

    expect(await screen.findByText('Job status unknown — the service may have restarted.')).toBeTruthy();

    // Wait a bit to ensure no further polls happen
    await new Promise((resolve) => setTimeout(resolve, 50));
    const pollCalls = fake.calls.filter((call) => call.includes('GET /api/jobs'));
    const finalPollCount = pollCalls.length;

    // Do another wait to verify no new polls
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(fake.calls.filter((call) => call.includes('GET /api/jobs')).length).toBe(finalPollCount);
  });

  it('does not update state after unmount during poll', async () => {
    const user = userEvent.setup();
    const fake = createFakeApi({ units: [makeUnit('A', 'PAUSED')], estimateUsd: 0.5, jobPolls: 100 });
    const onJobDone = vi.fn();
    const { unmount } = render(
      <JobsView api={new LocHubApi('', fake.fetch)} culture="ru" onJobDone={onJobDone} pollMs={5} />,
    );
    await user.click(screen.getByRole('button', { name: 'Estimate' }));
    expect(await screen.findByText(/estimated \$0\.50/)).toBeTruthy();

    const maxUsd = screen.getByLabelText('Max USD') as HTMLInputElement;
    await user.clear(maxUsd);
    await user.type(maxUsd, '1');
    await user.click(screen.getByRole('button', { name: 'Run' }));

    expect(await screen.findByText('Job running')).toBeTruthy();

    // Unmount while polling is in flight
    unmount();

    // Should not throw warnings about state updates on unmounted component
    await new Promise((resolve) => setTimeout(resolve, 50));
  });

  it('subscription: sync-only mode, no Max USD, no $ in the estimate, Run enabled, startJob called without maxUsd', async () => {
    const user = userEvent.setup();
    const fake = createFakeApi({ units: [makeUnit('A', 'PAUSED'), makeUnit('B', 'BACK')], estimateUsd: 0.5 });
    const api = new LocHubApi('', fake.fetch);
    const startJobSpy = vi.spyOn(api, 'startJob');
    render(<JobsView api={api} culture="ru" billing="subscription" onJobDone={vi.fn()} pollMs={5} />);

    expect(screen.queryByLabelText('Max USD')).toBeFalsy();

    await user.click(screen.getByRole('button', { name: 'Estimate' }));
    expect(await screen.findByText(/uses your Claude subscription limits/)).toBeTruthy();
    expect(screen.queryByText(/\$/)).toBeFalsy();
    expect(screen.queryByLabelText('Max USD')).toBeFalsy();

    const runButton = screen.getByRole('button', { name: 'Run' }) as HTMLButtonElement;
    expect(runButton.disabled).toBe(false);

    await user.click(runButton);
    await waitFor(() => expect(startJobSpy).toHaveBeenCalled());
    expect(startJobSpy.mock.calls[0]?.[1]).toBeUndefined();
  });

  it('never offers Batch: no Mode select anywhere, and estimate/start always send mode "sync", even when health reports Batch available', async () => {
    const user = userEvent.setup();
    const fake = createFakeApi({
      units: [makeUnit('A', 'PAUSED'), makeUnit('B', 'BACK')],
      estimateUsd: 0.5,
      // Batch reported available by the service; JobsView no longer reads this (the batchAvailable prop and the
      // Mode select were removed), so it must have no effect on what is rendered or sent.
      ai: { provider: 'anthropic', auth: 'api', translateModel: 'claude-opus-5-5', judgeModel: 'claude-sonnet-5', batch: true, ready: true, detail: '' },
    });
    const estimateBodies: Record<string, unknown>[] = [];
    const startBodies: Record<string, unknown>[] = [];
    const wrappedFetch: typeof fake.fetch = async (input, init) => {
      const url = new URL(input, 'http://lochub.test');
      if (init?.method === 'POST' && url.pathname === '/api/jobs/estimate') estimateBodies.push(JSON.parse(String(init.body)) as Record<string, unknown>);
      if (init?.method === 'POST' && url.pathname === '/api/jobs') startBodies.push(JSON.parse(String(init.body)) as Record<string, unknown>);
      return fake.fetch(input, init);
    };
    render(<JobsView api={new LocHubApi('', wrappedFetch)} culture="ru" billing="api" onJobDone={vi.fn()} pollMs={5} />);

    expect(screen.queryByLabelText('Mode')).toBeNull();
    expect(screen.queryByText(/Batch/)).toBeNull();

    await user.click(screen.getByRole('button', { name: 'Estimate' }));
    expect(await screen.findByText(/estimated \$0\.50/)).toBeTruthy();
    await waitFor(() => expect(estimateBodies).toHaveLength(1));
    expect(estimateBodies[0]?.mode).toBe('sync');

    const maxUsd = screen.getByLabelText('Max USD') as HTMLInputElement;
    await user.clear(maxUsd);
    await user.type(maxUsd, '1');
    await user.click(screen.getByRole('button', { name: 'Run' }));

    await waitFor(() => expect(startBodies).toHaveLength(1));
    expect(startBodies[0]?.mode).toBe('sync');
  });

  it('estimate with usd: null under api billing: no $, "price unknown for this model", no Max USD, Run enabled, startJob called without maxUsd', async () => {
    const user = userEvent.setup();
    const fake = createFakeApi({ units: [makeUnit('A', 'PAUSED'), makeUnit('B', 'BACK')], estimateUsd: null });
    const api = new LocHubApi('', fake.fetch);
    const startJobSpy = vi.spyOn(api, 'startJob');
    render(<JobsView api={api} culture="ru" billing="api" onJobDone={vi.fn()} pollMs={5} />);

    await user.click(screen.getByRole('button', { name: 'Estimate' }));
    expect(await screen.findByText(/price unknown for this model/)).toBeTruthy();
    expect(screen.queryByText(/\$/)).toBeFalsy();
    expect(screen.queryByLabelText('Max USD')).toBeFalsy();

    const runButton = screen.getByRole('button', { name: 'Run' }) as HTMLButtonElement;
    expect(runButton.disabled).toBe(false);

    await user.click(runButton);
    await waitFor(() => expect(startJobSpy).toHaveBeenCalled());
    expect(startJobSpy.mock.calls[0]?.[1]).toBeUndefined();
  });

  describe('job resume', () => {
    it('mounts and shows the already-running job for the culture without pressing Run, then polling reaches done', async () => {
      const fake = createFakeApi({ units: [makeUnit('A', 'PAUSED')], estimateUsd: 0.5, jobPolls: 1 });
      // Seed a job already running for 'ru' before JobsView ever mounts (as if started in a previous mount).
      await fake.fetch('/api/jobs', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ culture: 'ru', maxUsd: 5 }) });

      render(<JobsView api={new LocHubApi('', fake.fetch)} culture="ru" onJobDone={vi.fn()} pollMs={5} />);

      expect(await screen.findByText('Job running')).toBeTruthy();
      expect(screen.queryByRole('button', { name: 'Run' })).not.toBeTruthy();
      expect(await screen.findByText('Job done')).toBeTruthy();
      expect(screen.getByText(/Written 2/)).toBeTruthy();
    });

    it('still shows the running job after the view unmounts and mounts again', async () => {
      const fake = createFakeApi({ units: [makeUnit('A', 'PAUSED')], estimateUsd: 0.5, jobPolls: 100 });
      await fake.fetch('/api/jobs', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ culture: 'ru', maxUsd: 5 }) });

      const { unmount } = render(<JobsView api={new LocHubApi('', fake.fetch)} culture="ru" onJobDone={vi.fn()} pollMs={5} />);
      expect(await screen.findByText('Job running')).toBeTruthy();
      unmount();

      render(<JobsView api={new LocHubApi('', fake.fetch)} culture="ru" onJobDone={vi.fn()} pollMs={5} />);
      expect(await screen.findByText('Job running')).toBeTruthy();
    });

    it('shows the running job instead of the error when Run hits job_running', async () => {
      const user = userEvent.setup();
      // A job for 'ru' is already running (started elsewhere, e.g. by another view or tab); its id is what the
      // 409 below carries. culture="de" here keeps this view's own mount-time resume lookup (for 'de') empty,
      // so "Job running" only appears once Run below hits the 409, not from the resume effect.
      const fake = createFakeApi({ units: [makeUnit('A', 'PAUSED')], estimateUsd: 0.5, jobPolls: 1 });
      const startRes = await fake.fetch('/api/jobs', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ culture: 'ru', maxUsd: 5 }) });
      const runningJobId = (JSON.parse(await startRes.text()) as { jobId: string }).jobId;

      const wrappedFetch: typeof fake.fetch = async (input, init) => {
        const url = new URL(input, 'http://lochub.test');
        if (init?.method === 'POST' && url.pathname === '/api/jobs') {
          return { ok: false, status: 409, text: async () => JSON.stringify({ error: 'job_running', jobId: runningJobId }) } as Response;
        }
        return fake.fetch(input, init);
      };

      // A long pollMs here: the view's own poll timer would otherwise race the manual api.job() call the 409
      // handler makes below and consume the fake's single "running" answer first, making this test flaky. Only
      // the 409 handler's own lookup should produce the running state.
      render(<JobsView api={new LocHubApi('', wrappedFetch)} culture="de" onJobDone={vi.fn()} pollMs={60_000} />);
      await user.click(screen.getByRole('button', { name: 'Estimate' }));
      expect(await screen.findByText(/estimated \$0\.50/)).toBeTruthy();
      const maxUsd = screen.getByLabelText('Max USD') as HTMLInputElement;
      await user.clear(maxUsd);
      await user.type(maxUsd, '1');
      await user.click(screen.getByRole('button', { name: 'Run' }));

      expect(await screen.findByText('Job running')).toBeTruthy();
    });
  });

  describe('ai_not_ready (missing provider API key)', () => {
    it('shows the service message when Estimate hits 400 ai_not_ready', async () => {
      const user = userEvent.setup();
      const detail = 'OPENAI_API_KEY is not set: set it before starting the editor, then restart the editor.';
      const fake = createFakeApi({ units: [makeUnit('A', 'PAUSED')], aiNotReady: detail });
      render(<JobsView api={new LocHubApi('', fake.fetch)} culture="ru" onJobDone={vi.fn()} pollMs={5} />);

      await user.click(screen.getByRole('button', { name: 'Estimate' }));
      expect(await screen.findByText(detail)).toBeTruthy();
    });

    it('disables Estimate and Run with the ai detail as the tooltip while the provider is not ready', async () => {
      const user = userEvent.setup();
      const fake = createFakeApi({ units: [makeUnit('A', 'PAUSED')], estimateUsd: 0.5 });
      const api = new LocHubApi('', fake.fetch);
      const { rerender } = render(<JobsView api={api} culture="ru" aiReady={true} onJobDone={vi.fn()} pollMs={5} />);
      await user.click(screen.getByRole('button', { name: 'Estimate' }));
      expect(await screen.findByText(/estimated \$0\.50/)).toBeTruthy();

      const detail = 'OPENAI_API_KEY is not set: set it before starting the editor, then restart the editor.';
      rerender(<JobsView api={api} culture="ru" aiReady={false} aiDetail={detail} onJobDone={vi.fn()} pollMs={5} />);

      const estimateBtn = screen.getByRole('button', { name: 'Estimate' }) as HTMLButtonElement;
      expect(estimateBtn.disabled).toBe(true);
      expect(estimateBtn.title).toBe(detail);

      const runBtn = screen.getByRole('button', { name: 'Run' }) as HTMLButtonElement;
      expect(runBtn.disabled).toBe(true);
      expect(runBtn.title).toBe(detail);
    });
  });

  // estimate-speed-brief.md §3: the "Run without estimate" button.
  describe('Run without estimate', () => {
    it('starts a job with skipEstimate: true and no Estimate call first', async () => {
      const user = userEvent.setup();
      const fake = createFakeApi({ units: [makeUnit('A', 'PAUSED'), makeUnit('B', 'BACK')], jobPolls: 1 });
      render(<JobsView api={new LocHubApi('', fake.fetch)} culture="ru" onJobDone={vi.fn()} pollMs={5} />);

      await user.click(screen.getByRole('button', { name: 'Run without estimate' }));
      expect(await screen.findByText('Job done')).toBeTruthy();

      expect(fake.calls.some((call) => call.includes('POST /api/jobs/estimate'))).toBe(false);
      const startRequest = fake.requests.find((r) => r.method === 'POST' && r.path === '/api/jobs');
      expect(startRequest?.body).toMatchObject({ skipEstimate: true });
      expect(startRequest?.body.maxUsd).toBeUndefined();
    });

    it('has the exact "starts right away" tooltip', () => {
      const fake = createFakeApi({ units: [makeUnit('A', 'PAUSED')] });
      render(<JobsView api={new LocHubApi('', fake.fetch)} culture="ru" onJobDone={vi.fn()} pollMs={5} />);
      const button = screen.getByRole('button', { name: 'Run without estimate' }) as HTMLButtonElement;
      expect(button.title).toBe('Starts right away: no cost estimate and no Max USD limit. The job report shows the real cost.');
    });

    it('is disabled while AI is not ready', () => {
      const fake = createFakeApi({ units: [makeUnit('A', 'PAUSED')] });
      render(<JobsView api={new LocHubApi('', fake.fetch)} culture="ru" aiReady={false} aiDetail="not ready" onJobDone={vi.fn()} pollMs={5} />);
      expect((screen.getByRole('button', { name: 'Run without estimate' }) as HTMLButtonElement).disabled).toBe(true);
    });

    it('is disabled while Estimate is pending', async () => {
      const user = userEvent.setup();
      let estimateResolver!: (value: { estimate: JobEstimate }) => void;
      const estimatePromise = new Promise<{ estimate: JobEstimate }>((resolve) => {
        estimateResolver = resolve;
      });
      const fake = createFakeApi({ units: [makeUnit('A', 'PAUSED')] });
      const wrappedFetch: typeof fake.fetch = async (input, init) => {
        const url = new URL(input, 'http://lochub.test');
        if (init?.method === 'POST' && url.pathname === '/api/jobs/estimate') {
          return { ok: true, status: 200, text: async () => JSON.stringify(await estimatePromise) } as Response;
        }
        return fake.fetch(input, init);
      };
      render(<JobsView api={new LocHubApi('', wrappedFetch)} culture="ru" onJobDone={vi.fn()} pollMs={5} />);

      await user.click(screen.getByRole('button', { name: 'Estimate' }));
      expect((screen.getByRole('button', { name: 'Run without estimate' }) as HTMLButtonElement).disabled).toBe(true);

      estimateResolver({ estimate: { items: 1, requests: 1, inputTokens: 100, outputTokens: 50, usd: 0.5, strings: 1 } });
      await screen.findByRole('button', { name: 'Estimate' });
      expect((screen.getByRole('button', { name: 'Run without estimate' }) as HTMLButtonElement).disabled).toBe(false);
    });

    it('is disabled while starting, and stays disabled while the job is running', async () => {
      const user = userEvent.setup();
      // Lets POST /api/jobs actually run (so the job record exists for later polls) while holding its response
      // from the client until the test releases it -- the same technique the "estimate pending" tests above use
      // for POST /api/jobs/estimate, just gated manually instead of by an unresolved fetch.
      let releaseStart!: () => void;
      const startGate = new Promise<void>((resolve) => {
        releaseStart = resolve;
      });
      const fake = createFakeApi({ units: [makeUnit('A', 'PAUSED')], jobPolls: 5 });
      const wrappedFetch: typeof fake.fetch = async (input, init) => {
        const url = new URL(input, 'http://lochub.test');
        if (init?.method === 'POST' && url.pathname === '/api/jobs') {
          const real = await fake.fetch(input, init);
          await startGate;
          return real;
        }
        return fake.fetch(input, init);
      };
      render(<JobsView api={new LocHubApi('', wrappedFetch)} culture="ru" onJobDone={vi.fn()} pollMs={5} />);

      await user.click(screen.getByRole('button', { name: 'Run without estimate' }));
      // Starting: the request to POST /api/jobs is still held open.
      expect((screen.getByRole('button', { name: 'Run without estimate' }) as HTMLButtonElement).disabled).toBe(true);

      releaseStart();
      expect(await screen.findByText('Job running')).toBeTruthy();
      // Running: the job stays 'running' for several polls (jobPolls: 5).
      expect((screen.getByRole('button', { name: 'Run without estimate' }) as HTMLButtonElement).disabled).toBe(true);
    });

    it('renders the approximate marker when the estimate carries approximate: true', async () => {
      const user = userEvent.setup();
      const fake = createFakeApi({ units: [makeUnit('A', 'PAUSED')], estimateUsd: 0.5, estimateApproximate: true });
      render(<JobsView api={new LocHubApi('', fake.fetch)} culture="ru" onJobDone={vi.fn()} pollMs={5} />);

      await user.click(screen.getByRole('button', { name: 'Estimate' }));
      expect(await screen.findByText(/estimated \$0\.50/)).toBeTruthy();
      expect(screen.getByText(/Approximate/)).toBeTruthy();
    });
  });

  describe('estimate pending state', () => {
    it('shows pending state while estimating, prevents double-click, and clears when done', async () => {
      const user = userEvent.setup();
      let estimateResolver: (value: { estimate: JobEstimate }) => void;
      const estimatePromise = new Promise<{ estimate: JobEstimate }>((resolve) => {
        estimateResolver = resolve;
      });
      const fake = createFakeApi({ units: [makeUnit('A', 'PAUSED')] });
      const wrappedFetch: typeof fake.fetch = async (input, init) => {
        const url = new URL(input, 'http://lochub.test');
        if (init?.method === 'POST' && url.pathname === '/api/jobs/estimate') {
          return {
            ok: true,
            status: 200,
            text: async () => JSON.stringify(await estimatePromise),
          } as Response;
        }
        return fake.fetch(input, init);
      };

      render(<JobsView api={new LocHubApi('', wrappedFetch)} culture="ru" onJobDone={vi.fn()} pollMs={5} />);

      // Click Estimate; the button should show "Estimating…" and be disabled
      await user.click(screen.getByRole('button', { name: 'Estimate' }));
      const estimatingBtn = screen.getByRole('button', { name: 'Estimating…' }) as HTMLButtonElement;
      expect(estimatingBtn).toBeTruthy();
      expect(estimatingBtn.disabled).toBe(true);
      expect(screen.getByText('Estimating the cost…')).toBeTruthy();

      // A second click should not trigger another estimate call
      const estimateCalls = fake.calls.filter((call) => call.includes('POST /api/jobs/estimate')).length;
      await user.click(estimatingBtn);
      expect(fake.calls.filter((call) => call.includes('POST /api/jobs/estimate')).length).toBe(estimateCalls);

      // Resolve the promise; the button should go back to "Estimate", be enabled, and status should disappear
      estimateResolver!({ estimate: { items: 2, requests: 1, inputTokens: 100, outputTokens: 50, usd: 0.5, strings: 2 } });
      expect(await screen.findByRole('button', { name: 'Estimate' })).toBeTruthy();
      const estimateBtn = screen.getByRole('button', { name: 'Estimate' }) as HTMLButtonElement;
      expect(estimateBtn.disabled).toBe(false);
      expect(screen.queryByText('Estimating the cost…')).not.toBeTruthy();
      expect(await screen.findByText(/estimated \$0\.50/)).toBeTruthy();
    });

    it('clears pending state and shows error when estimate fails', async () => {
      const user = userEvent.setup();
      let estimateRejecter: (reason: Error) => void;
      const estimatePromise = new Promise<{ estimate: JobEstimate }>((_, reject) => {
        estimateRejecter = reject;
      });
      const fake = createFakeApi({ units: [makeUnit('A', 'PAUSED')] });
      const wrappedFetch: typeof fake.fetch = async (input, init) => {
        const url = new URL(input, 'http://lochub.test');
        if (init?.method === 'POST' && url.pathname === '/api/jobs/estimate') {
          try {
            const result = await estimatePromise;
            return {
              ok: true,
              status: 200,
              text: async () => JSON.stringify(result),
            } as Response;
          } catch (e) {
            return {
              ok: false,
              status: 500,
              text: async () => JSON.stringify({ error: (e as Error).message }),
            } as Response;
          }
        }
        return fake.fetch(input, init);
      };

      render(<JobsView api={new LocHubApi('', wrappedFetch)} culture="ru" onJobDone={vi.fn()} pollMs={5} />);

      await user.click(screen.getByRole('button', { name: 'Estimate' }));
      const estimatingBtn = screen.getByRole('button', { name: 'Estimating…' }) as HTMLButtonElement;
      expect(estimatingBtn).toBeTruthy();
      expect(screen.getByText('Estimating the cost…')).toBeTruthy();

      // Reject the promise
      estimateRejecter!(new Error('Network error'));
      expect(await screen.findByRole('button', { name: 'Estimate' })).toBeTruthy();
      const estimateBtn = screen.getByRole('button', { name: 'Estimate' }) as HTMLButtonElement;
      expect(estimateBtn.disabled).toBe(false);
      expect(screen.queryByText('Estimating the cost…')).not.toBeTruthy();
      expect(screen.getByText('Network error')).toBeTruthy();
    });

    it('clears a pending Estimate as soon as the scope changes, and ignores a stale response for the old scope', async () => {
      const user = userEvent.setup();
      let estimateResolver!: (value: { estimate: JobEstimate }) => void;
      const estimatePromise = new Promise<{ estimate: JobEstimate }>((resolve) => {
        estimateResolver = resolve;
      });
      const fake = createFakeApi({ units: [makeUnit('A', 'PAUSED', { groupKey: 'Pause' })] });
      const wrappedFetch: typeof fake.fetch = async (input, init) => {
        const url = new URL(input, 'http://lochub.test');
        if (init?.method === 'POST' && url.pathname === '/api/jobs/estimate') {
          return { ok: true, status: 200, text: async () => JSON.stringify(await estimatePromise) } as Response;
        }
        return fake.fetch(input, init);
      };

      render(<JobsView api={new LocHubApi('', wrappedFetch)} culture="ru" onJobDone={vi.fn()} pollMs={5} />);

      await user.click(screen.getByRole('button', { name: 'Estimate' }));
      expect(screen.getByRole('button', { name: 'Estimating…' })).toBeTruthy();

      // Change the scope (Group) while the Estimate for the old scope is still in flight.
      await user.type(screen.getByRole('combobox', { name: 'Group' }), 'Pause{Enter}');

      // The pending state belongs to the scope it was made for: changing scope clears it right away, without
      // waiting for the in-flight request to settle.
      expect(screen.getByRole('button', { name: 'Estimate' })).toBeTruthy();
      expect(screen.queryByRole('button', { name: 'Estimating…' })).toBeNull();
      expect(screen.queryByText('Estimating the cost…')).toBeNull();

      // The stale response for the old scope now arrives; it must not resurrect an estimate for the new one.
      estimateResolver({ estimate: { items: 1, requests: 1, inputTokens: 100, outputTokens: 50, usd: 0.5, strings: 1 } });
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(screen.queryByText(/estimated \$0\.50/)).toBeNull();
      expect(screen.queryByRole('button', { name: 'Run' })).toBeNull();
      expect((screen.getByRole('button', { name: 'Estimate' }) as HTMLButtonElement).disabled).toBe(false);
    });
  });

  describe('job progress', () => {
    it('renders a progressbar with the aria values and label while a running job carries progress', async () => {
      const user = userEvent.setup();
      const fake = createFakeApi({ units: [makeUnit('A', 'PAUSED')], estimateUsd: 0.5, jobPolls: 5 });
      fake.state.jobProgress = { phase: 'translate', done: 3, total: 10 };
      render(<JobsView api={new LocHubApi('', fake.fetch)} culture="ru" onJobDone={vi.fn()} pollMs={5} />);

      await user.click(screen.getByRole('button', { name: 'Estimate' }));
      expect(await screen.findByText(/estimated \$0\.50/)).toBeTruthy();
      const maxUsd = screen.getByLabelText('Max USD') as HTMLInputElement;
      await user.clear(maxUsd);
      await user.type(maxUsd, '1');
      await user.click(screen.getByRole('button', { name: 'Run' }));

      const bar = await screen.findByRole('progressbar');
      expect(bar.getAttribute('aria-valuemin')).toBe('0');
      expect(bar.getAttribute('aria-valuemax')).toBe('10');
      expect(bar.getAttribute('aria-valuenow')).toBe('3');
      expect(bar.getAttribute('aria-label')).toBe('Job progress');
      expect(screen.getByText('Translating · 3 / 10 strings')).toBeTruthy();
      expect(screen.queryByText('Job running')).toBeFalsy();
    });

    it('keeps the plain "Job running" text when the running job has no progress yet', async () => {
      const user = userEvent.setup();
      const fake = createFakeApi({ units: [makeUnit('A', 'PAUSED')], estimateUsd: 0.5, jobPolls: 5 });
      render(<JobsView api={new LocHubApi('', fake.fetch)} culture="ru" onJobDone={vi.fn()} pollMs={5} />);

      await user.click(screen.getByRole('button', { name: 'Estimate' }));
      expect(await screen.findByText(/estimated \$0\.50/)).toBeTruthy();
      const maxUsd = screen.getByLabelText('Max USD') as HTMLInputElement;
      await user.clear(maxUsd);
      await user.type(maxUsd, '1');
      await user.click(screen.getByRole('button', { name: 'Run' }));

      expect(await screen.findByText('Job running')).toBeTruthy();
      expect(screen.queryByRole('progressbar')).toBeFalsy();
    });
  });

  describe('Group PathFilter (path/folder filter)', () => {
    it('offers suggestions from the loaded rows\' group keys, counting only strings still to translate', async () => {
      const user = userEvent.setup();
      const rows = [
        groupedRow('A', 'Pause', 'empty'),
        groupedRow('B', 'Pause', 'empty'),
        groupedRow('C', 'Pause', 'approved'), // done: excluded from the count
        groupedRow('D', 'Hud', 'needs_fix'),
      ];
      const fake = createFakeApi({ units: [makeUnit('A', 'PAUSED')] });
      render(<JobsView api={new LocHubApi('', fake.fetch)} culture="ru" rows={rows} onJobDone={vi.fn()} pollMs={5} />);
      await user.click(screen.getByRole('combobox', { name: 'Group' }));
      await user.type(screen.getByRole('combobox', { name: 'Group' }), 'pause');
      expect(screen.getByRole('option', { name: 'Pause — 2' })).toBeTruthy();
    });

    it('sends the typed group as groupKey, and a value ending in "/" as groupPrefix', async () => {
      const user = userEvent.setup();
      const startBodies: Record<string, unknown>[] = [];
      const fake = createFakeApi({ units: [makeUnit('A', 'PAUSED', { groupKey: '/Game/UI/Pause' })], estimateUsd: 0.5 });
      const wrappedFetch: typeof fake.fetch = async (input, init) => {
        const url = new URL(input, 'http://lochub.test');
        if (init?.method === 'POST' && url.pathname === '/api/jobs/estimate') startBodies.push(JSON.parse(String(init.body)) as Record<string, unknown>);
        return fake.fetch(input, init);
      };
      render(<JobsView api={new LocHubApi('', wrappedFetch)} culture="ru" rows={[groupedRow('A', '/Game/UI/Pause')]} onJobDone={vi.fn()} pollMs={5} />);

      // Enter applies the typed text right away; moving focus elsewhere (a blur, e.g. clicking Estimate) commits
      // it too, so either path picks up what was typed.
      const input = screen.getByRole('combobox', { name: 'Group' });
      await user.type(input, '/Game/UI/Pause{Enter}');
      await user.click(screen.getByRole('button', { name: 'Estimate' }));
      await waitFor(() => expect(startBodies).toHaveLength(1));
      expect(startBodies[0]).toMatchObject({ groupKey: '/Game/UI/Pause' });
      expect(startBodies[0]).not.toHaveProperty('groupPrefix');

      await user.clear(input);
      await user.type(input, '/Game/UI/{Enter}');
      await user.click(screen.getByRole('button', { name: 'Estimate' }));
      await waitFor(() => expect(startBodies).toHaveLength(2));
      expect(startBodies[1]).toMatchObject({ groupPrefix: '/Game/UI/' });
      expect(startBodies[1]).not.toHaveProperty('groupKey');
    });

    it('commits a typed group on blur, so clicking Estimate without pressing Enter first still applies it', async () => {
      const user = userEvent.setup();
      const startBodies: Record<string, unknown>[] = [];
      const fake = createFakeApi({ units: [makeUnit('A', 'PAUSED', { groupKey: '/Game/UI/Pause' })], estimateUsd: 0.5 });
      const wrappedFetch: typeof fake.fetch = async (input, init) => {
        const url = new URL(input, 'http://lochub.test');
        if (init?.method === 'POST' && url.pathname === '/api/jobs/estimate') startBodies.push(JSON.parse(String(init.body)) as Record<string, unknown>);
        return fake.fetch(input, init);
      };
      render(<JobsView api={new LocHubApi('', wrappedFetch)} culture="ru" rows={[groupedRow('A', '/Game/UI/Pause')]} onJobDone={vi.fn()} pollMs={5} />);

      const input = screen.getByRole('combobox', { name: 'Group' });
      await user.type(input, '/Game/UI/Pause');
      await user.click(screen.getByRole('button', { name: 'Estimate' }));
      await waitFor(() => expect(startBodies).toHaveLength(1));
      expect(startBodies[0]).toMatchObject({ groupKey: '/Game/UI/Pause' });
    });

    it('shows "No strings match this group." instead of a $0 estimate when the group matches nothing', async () => {
      const user = userEvent.setup();
      const fake = createFakeApi({ units: [makeUnit('A', 'PAUSED', { groupKey: 'Pause' })], estimateUsd: 0.5 });
      render(<JobsView api={new LocHubApi('', fake.fetch)} culture="ru" rows={[groupedRow('A', 'Pause')]} onJobDone={vi.fn()} pollMs={5} />);

      const input = screen.getByRole('combobox', { name: 'Group' });
      await user.type(input, 'NoSuchGroup{Enter}');
      await user.click(screen.getByRole('button', { name: 'Estimate' }));

      expect(await screen.findByText('No strings match this group.')).toBeTruthy();
      expect(screen.queryByRole('button', { name: 'Run' })).toBeNull();
    });
  });

  describe('estimate.strings (translation memory and cached-answer reuse)', () => {
    it('shows "Nothing to translate." when strings is 0 and no group is set', async () => {
      const user = userEvent.setup();
      const fake = createFakeApi({ units: [] });
      render(<JobsView api={new LocHubApi('', fake.fetch)} culture="ru" onJobDone={vi.fn()} pollMs={5} />);

      await user.click(screen.getByRole('button', { name: 'Estimate' }));
      expect(await screen.findByText('Nothing to translate.')).toBeTruthy();
      expect(screen.queryByRole('button', { name: 'Run' })).toBeNull();
    });

    it('when every string reuses TM/cache (items 0, strings > 0): shows the reuse message, enables Run with no Max USD, and starts the job without maxUsd', async () => {
      const user = userEvent.setup();
      const fake = createFakeApi({ units: [], estimateUsd: 0, estimateStrings: 5 });
      const api = new LocHubApi('', fake.fetch);
      const startJobSpy = vi.spyOn(api, 'startJob');
      render(<JobsView api={api} culture="ru" onJobDone={vi.fn()} pollMs={5} />);

      await user.click(screen.getByRole('button', { name: 'Estimate' }));
      expect(await screen.findByText('5 strings reuse translation memory or cached answers — no translate cost is estimated; judging may still run.')).toBeTruthy();
      expect(screen.queryByLabelText('Max USD')).toBeNull();

      const runButton = screen.getByRole('button', { name: 'Run' }) as HTMLButtonElement;
      expect(runButton.disabled).toBe(false);

      await user.click(runButton);
      await waitFor(() => expect(startJobSpy).toHaveBeenCalled());
      expect(startJobSpy.mock.calls[0]?.[1]).toBeUndefined();
    });

    it('an older service that omits strings entirely falls back to items (items 0 shows "Nothing to translate.")', async () => {
      const user = userEvent.setup();
      const fake = createFakeApi({ units: [], estimateStrings: null });
      render(<JobsView api={new LocHubApi('', fake.fetch)} culture="ru" onJobDone={vi.fn()} pollMs={5} />);

      await user.click(screen.getByRole('button', { name: 'Estimate' }));
      expect(await screen.findByText('Nothing to translate.')).toBeTruthy();
      expect(screen.queryByRole('button', { name: 'Run' })).toBeNull();
    });

    it('an unpriced model (usd null) still enables Run when every string reuses TM/cache (items 0, strings > 0)', async () => {
      const user = userEvent.setup();
      const fake = createFakeApi({ units: [], estimateUsd: null, estimateStrings: 5 });
      const api = new LocHubApi('', fake.fetch);
      const startJobSpy = vi.spyOn(api, 'startJob');
      render(<JobsView api={api} culture="ru" onJobDone={vi.fn()} pollMs={5} />);

      await user.click(screen.getByRole('button', { name: 'Estimate' }));
      expect(await screen.findByText('5 strings reuse translation memory or cached answers — no translate cost is estimated; judging may still run.')).toBeTruthy();

      const runButton = screen.getByRole('button', { name: 'Run' }) as HTMLButtonElement;
      expect(runButton.disabled).toBe(false);

      await user.click(runButton);
      await waitFor(() => expect(startJobSpy).toHaveBeenCalled());
      expect(startJobSpy.mock.calls[0]?.[1]).toBeUndefined();
    });
  });

  describe('job error reasons', () => {
    it('shows errorSamples as a short list under "Error reasons" for a finished job', async () => {
      const user = userEvent.setup();
      const fake = createFakeApi({ units: [makeUnit('A', 'PAUSED')], estimateUsd: 0.5, jobPolls: 1 });
      fake.state.jobErrorSamples = ['The model x does not exist'];
      render(<JobsView api={new LocHubApi('', fake.fetch)} culture="ru" onJobDone={vi.fn()} pollMs={5} />);

      await user.click(screen.getByRole('button', { name: 'Estimate' }));
      expect(await screen.findByText(/estimated \$0\.50/)).toBeTruthy();
      const maxUsd = screen.getByLabelText('Max USD') as HTMLInputElement;
      await user.clear(maxUsd);
      await user.type(maxUsd, '1');
      await user.click(screen.getByRole('button', { name: 'Run' }));

      expect(await screen.findByText('Job done')).toBeTruthy();
      expect(screen.getByText('Error reasons')).toBeTruthy();
      expect(screen.getByText('The model x does not exist')).toBeTruthy();
    });
  });
});
