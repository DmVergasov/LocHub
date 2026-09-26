import type { BridgeCommand } from './contract.js';

// The UE HTTP module drops a request after 30 s without traffic (FHttpModule::StartupModule sets
// HttpActivityTimeout = 30), so an idle editor stream gets a comment line well inside that window.
export const HEARTBEAT_MS = 15_000;

// Editors connect with an outgoing SSE stream; commands from the web app are relayed to every connected editor.
export class BridgeHub {
  private readonly clients = new Set<(chunk: string) => void>();

  add(write: (chunk: string) => void): () => void {
    this.clients.add(write);
    return () => this.clients.delete(write);
  }

  get connected(): number {
    return this.clients.size;
  }

  send(command: BridgeCommand): number {
    const chunk = `event: command\ndata: ${JSON.stringify(command)}\n\n`;
    for (const write of this.clients) write(chunk);
    return this.clients.size;
  }
}

// One editor stream: a greeting comment, the relayed commands and a heartbeat. The returned function detaches it.
export function attachEditorStream(hub: BridgeHub, write: (chunk: string) => void, heartbeatMs: number = HEARTBEAT_MS): () => void {
  write(': connected\n\n');
  const remove = hub.add(write);
  const timer = setInterval(() => write(': ping\n\n'), heartbeatMs);
  return () => {
    clearInterval(timer);
    remove();
  };
}
