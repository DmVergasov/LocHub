import { afterEach, describe, expect, it, vi } from 'vitest';
import { attachEditorStream, BridgeHub } from '../src/bridge.js';

afterEach(() => {
  vi.useRealTimers();
});

describe('attachEditorStream', () => {
  it('greets, relays commands, pings while idle and stops after detach', () => {
    vi.useFakeTimers();
    const hub = new BridgeHub();
    const chunks: string[] = [];
    const detach = attachEditorStream(hub, (chunk) => chunks.push(chunk), 1000);
    expect(chunks).toEqual([': connected\n\n']);
    expect(hub.connected).toBe(1);

    hub.send({ name: 'SetPreviewCulture', args: { culture: 'ru' } });
    vi.advanceTimersByTime(2500);
    expect(chunks.slice(1)).toEqual([
      'event: command\ndata: {"name":"SetPreviewCulture","args":{"culture":"ru"}}\n\n',
      ': ping\n\n',
      ': ping\n\n',
    ]);

    detach();
    vi.advanceTimersByTime(5000);
    expect(chunks).toHaveLength(4);
    expect(hub.connected).toBe(0);
  });
});
