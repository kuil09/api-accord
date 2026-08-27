import type { Logger } from '@api-accord/config';
import { errorMetadata } from '@api-accord/config';

import type { JobQueue, QueuedJob } from './queue.js';

export type JobHandler = (job: QueuedJob) => Promise<void>;

export interface WorkerRuntimeOptions {
  readonly queue: JobQueue;
  readonly logger: Logger;
  readonly pollIntervalMs: number;
  readonly handlers: Readonly<Record<string, JobHandler>>;
}

export class WorkerRuntime {
  readonly #queue: JobQueue;
  readonly #logger: Logger;
  readonly #pollIntervalMs: number;
  readonly #handlers: Readonly<Record<string, JobHandler>>;
  #running = false;
  #busy = false;
  #timer: ReturnType<typeof setTimeout> | undefined;

  constructor(options: WorkerRuntimeOptions) {
    this.#queue = options.queue;
    this.#logger = options.logger;
    this.#pollIntervalMs = options.pollIntervalMs;
    this.#handlers = options.handlers;
  }

  start(): void {
    if (this.#running) {
      return;
    }

    this.#running = true;
    this.schedule(0);
  }

  async stop(): Promise<void> {
    this.#running = false;
    if (this.#timer !== undefined) {
      clearTimeout(this.#timer);
      this.#timer = undefined;
    }

    while (this.#busy) {
      await delay(25);
    }

    await this.#queue.close();
  }

  async checkReady(): Promise<void> {
    if (!this.#running) {
      throw new Error('worker runtime has not started');
    }
    await this.#queue.ping();
  }

  private schedule(delayMs: number): void {
    if (!this.#running) {
      return;
    }

    this.#timer = setTimeout(() => {
      void this.pollAndReschedule();
    }, delayMs);
  }

  private async pollAndReschedule(): Promise<void> {
    try {
      await this.runOnce();
    } catch (error) {
      this.#logger.error('worker.poll.failed', errorMetadata(error));
    } finally {
      this.schedule(this.#pollIntervalMs);
    }
  }

  private async runOnce(): Promise<void> {
    if (this.#busy || !this.#running) {
      return;
    }

    this.#busy = true;
    let job: QueuedJob | undefined;

    try {
      job = await this.#queue.claim();
      if (job === undefined) {
        return;
      }

      const handler = this.#handlers[job.jobType];
      if (handler === undefined) {
        throw new Error(`No handler registered for job type ${job.jobType}`);
      }

      this.#logger.info('worker.job.started', {
        jobId: job.id,
        jobType: job.jobType,
        attempt: job.attempts
      });
      await handler(job);
      await this.#queue.complete(job.id);
      this.#logger.info('worker.job.completed', {
        jobId: job.id,
        jobType: job.jobType
      });
    } catch (error) {
      this.#logger.error('worker.job.failed', {
        jobId: job?.id,
        jobType: job?.jobType,
        ...errorMetadata(error)
      });
      if (job !== undefined) {
        try {
          await this.#queue.fail(job.id, error instanceof Error ? error.message : String(error));
        } catch (failError) {
          this.#logger.error('worker.job.failure_recording_failed', {
            jobId: job.id,
            ...errorMetadata(failError)
          });
        }
      }
    } finally {
      this.#busy = false;
    }
  }
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
