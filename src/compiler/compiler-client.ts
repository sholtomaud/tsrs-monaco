import type { CompileResult, CompilerMessage } from './protocol.ts';
import type { ProjectFiles } from './project.ts';

interface Pending {
  resolve: (result: CompileResult) => void;
  reject: (error: Error) => void;
}

/** Promise wrapper around compiler.worker.ts. */
export class CompilerClient extends EventTarget {
  private worker!: Worker;
  private pending = new Map<number, Pending>();
  private nextId = 1;
  ready = false;

  constructor() {
    super();
    this.start();
  }

  private start() {
    this.ready = false;
    this.worker = new Worker(
      new URL('./compiler.worker.ts', import.meta.url),
      { type: 'module' }
    );
    this.worker.onmessage = (event: MessageEvent<CompilerMessage>) => {
      const message = event.data;
      if (message.type === 'ready') {
        this.ready = true;
        this.dispatchEvent(
          new CustomEvent('ready', { detail: message.durationMs })
        );
        return;
      }
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      if (message.type === 'result') pending.resolve(message.result);
      else pending.reject(new Error(message.message));
    };
    // A trap (e.g. stack overflow) can take the worker down; fail what was in
    // flight and start over so the next edit still gets checked.
    this.worker.onerror = (event) => {
      event.preventDefault();
      const error = new Error(event.message || 'The compiler worker crashed.');
      for (const pending of this.pending.values()) pending.reject(error);
      this.pending.clear();
      this.worker.terminate();
      this.start();
    };
  }

  compile(files: ProjectFiles): Promise<CompileResult> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.worker.postMessage({ id, files });
    });
  }
}
