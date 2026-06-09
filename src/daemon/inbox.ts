// The wake inbox — the dispatch *shape* without the multi-worker machinery
// (reef-docs/05). Every reason the agent wakes (a user message now; schedule /
// file-watch / heartbeat later) enters here and is processed serially: the
// per-agent "one run in flight at a time" guarantee the loop's correctness
// depends on (reef-docs/03). Atomic-claim, priority, and cross-agent
// concurrency are deferred until there's more than one agent.

interface Job<T> {
  item: T;
  resolve: () => void;
  reject: (err: unknown) => void;
}

export class Inbox<T> {
  private readonly queue: Job<T>[] = [];
  private draining = false;

  constructor(private readonly handler: (item: T) => Promise<void>) {}

  /** Enqueue a wake; resolves when *this* wake has been fully processed. */
  enqueue(item: T): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      this.queue.push({ item, resolve, reject });
      void this.drain();
    });
  }

  private async drain(): Promise<void> {
    if (this.draining) return;
    this.draining = true;
    try {
      let job: Job<T> | undefined;
      while ((job = this.queue.shift())) {
        try {
          await this.handler(job.item);
          job.resolve();
        } catch (err) {
          job.reject(err);
        }
      }
    } finally {
      this.draining = false;
    }
  }
}
