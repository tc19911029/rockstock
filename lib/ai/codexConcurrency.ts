export type CodexQueueState = 'queued' | 'running';

export interface CodexQueueProgress {
  state: CodexQueueState;
  queuePosition: number | null;
  activeCount: number;
  maxConcurrent: number;
}

export interface CodexSchedulerSnapshot {
  activeCount: number;
  queuedCount: number;
  maxConcurrent: number;
}

interface QueueEntry {
  resolve: (release: () => void) => void;
  reject: (error: Error) => void;
  signal?: AbortSignal;
  onAbort?: () => void;
  onProgress?: (progress: CodexQueueProgress) => void;
}

function abortError(): Error {
  const error = new Error('Codex 分析已取消');
  error.name = 'AbortError';
  return error;
}

/**
 * Process-wide Codex worker pool. The queue is FIFO and reports real queue
 * positions whenever a slot is released or a waiting request is cancelled.
 */
export class CodexConcurrencyScheduler {
  private activeCount = 0;
  private readonly queue: QueueEntry[] = [];

  constructor(private readonly maxConcurrent: number) {
    if (!Number.isInteger(maxConcurrent) || maxConcurrent < 1) {
      throw new Error('maxConcurrent 必須是正整數');
    }
  }

  acquire(options: {
    signal?: AbortSignal;
    onProgress?: (progress: CodexQueueProgress) => void;
  } = {}): Promise<() => void> {
    if (options.signal?.aborted) return Promise.reject(abortError());

    if (this.activeCount < this.maxConcurrent) {
      this.activeCount += 1;
      this.notify(options.onProgress, {
        state: 'running',
        queuePosition: null,
        activeCount: this.activeCount,
        maxConcurrent: this.maxConcurrent,
      });
      return Promise.resolve(this.createRelease());
    }

    return new Promise((resolve, reject) => {
      const entry: QueueEntry = {
        resolve,
        reject,
        signal: options.signal,
        onProgress: options.onProgress,
      };
      if (options.signal) {
        entry.onAbort = () => {
          const index = this.queue.indexOf(entry);
          if (index < 0) return;
          this.queue.splice(index, 1);
          entry.reject(abortError());
          this.notifyQueuePositions();
        };
        options.signal.addEventListener('abort', entry.onAbort, { once: true });
      }
      this.queue.push(entry);
      this.notifyQueuePositions();
    });
  }

  snapshot(): CodexSchedulerSnapshot {
    return {
      activeCount: this.activeCount,
      queuedCount: this.queue.length,
      maxConcurrent: this.maxConcurrent,
    };
  }

  private createRelease(): () => void {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.activeCount = Math.max(0, this.activeCount - 1);
      this.drain();
    };
  }

  private drain(): void {
    while (this.activeCount < this.maxConcurrent && this.queue.length > 0) {
      const entry = this.queue.shift();
      if (!entry) break;
      if (entry.onAbort && entry.signal) {
        entry.signal.removeEventListener('abort', entry.onAbort);
      }
      if (entry.signal?.aborted) {
        entry.reject(abortError());
        continue;
      }
      this.activeCount += 1;
      this.notify(entry.onProgress, {
        state: 'running',
        queuePosition: null,
        activeCount: this.activeCount,
        maxConcurrent: this.maxConcurrent,
      });
      entry.resolve(this.createRelease());
    }
    this.notifyQueuePositions();
  }

  private notifyQueuePositions(): void {
    this.queue.forEach((entry, index) => {
      this.notify(entry.onProgress, {
        state: 'queued',
        queuePosition: index + 1,
        activeCount: this.activeCount,
        maxConcurrent: this.maxConcurrent,
      });
    });
  }

  private notify(
    callback: ((progress: CodexQueueProgress) => void) | undefined,
    progress: CodexQueueProgress,
  ): void {
    try {
      callback?.(progress);
    } catch (error) {
      console.warn('[codex-scheduler] progress callback failed:', error);
    }
  }
}

const globalForCodex = globalThis as typeof globalThis & {
  __rockstockCodexScheduler?: CodexConcurrencyScheduler;
};

export const codexScheduler = globalForCodex.__rockstockCodexScheduler
  ?? new CodexConcurrencyScheduler(3);

globalForCodex.__rockstockCodexScheduler = codexScheduler;

export function getCodexSchedulerSnapshot(): CodexSchedulerSnapshot {
  return codexScheduler.snapshot();
}
