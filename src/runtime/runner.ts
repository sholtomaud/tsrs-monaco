import type { RunMessage, RunRequest } from './protocol.ts';

/**
 * Starts a fresh run worker for each run. The worker is kept alive after the
 * entry module finishes so timers and promises can keep logging, until the
 * next run or stop().
 */
export class Runner {
  private worker: Worker | null = null;

  run(request: RunRequest, onMessage: (message: RunMessage) => void) {
    this.stop();
    const worker = new Worker(new URL('./run.worker.ts', import.meta.url), {
      type: 'module',
    });
    worker.onmessage = (event: MessageEvent<RunMessage>) => {
      if (this.worker === worker) onMessage(event.data);
    };
    worker.onerror = (event) => {
      event.preventDefault();
      if (this.worker === worker) {
        onMessage({ type: 'error', text: event.message || 'Worker error' });
      }
    };
    worker.postMessage(request);
    this.worker = worker;
  }

  get running() {
    return this.worker !== null;
  }

  stop() {
    this.worker?.terminate();
    this.worker = null;
  }
}
