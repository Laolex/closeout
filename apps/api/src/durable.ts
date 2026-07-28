import { closeSync, fsyncSync, mkdirSync, openSync, readFileSync, writeSync } from "node:fs";
import { dirname } from "node:path";

import type { Job } from "@closeout/core";

import type { JobStore } from "./app.js";
import type { PaidStore } from "./payment.js";

/**
 * Durable stores, as an append-only log.
 *
 * The in-memory versions are fine for tests and for the free prototype,
 * but not for anything taking payments. Persist-before-settle is about
 * *durability*, not only ordering: with the idempotency record in memory,
 * a restart between settling and a replay loses it and the same payment
 * settles twice — the caller charged twice for one job, which is exactly
 * the failure the rule exists to prevent.
 *
 * An append-only log rather than SQLite because the native sqlite binding
 * segfaults in this environment, and because the properties actually
 * needed here are narrow: small record count, primary-key lookup, and a
 * write that survives a hard stop. Appending a line and calling `fsync`
 * gives that with no native dependency and a file you can read with your
 * eyes when something looks wrong.
 *
 * Records are written whole, as canonical JSON, and the last write for a
 * key wins on replay. Amounts stay decimal strings throughout: an atomic
 * amount can exceed what a double holds exactly, and a round-trip
 * through a number would silently change what is owed.
 */
interface LogEntry<T> {
  key: string;
  value: T;
  at: string;
}

class AppendLog<T> {
  private readonly index = new Map<string, T>();
  private readonly fd: number;

  constructor(private readonly path: string) {
    mkdirSync(dirname(path), { recursive: true });
    this.replay();
    this.fd = openSync(path, "a");
  }

  private replay(): void {
    let contents: string;
    try {
      contents = readFileSync(this.path, "utf8");
    } catch {
      return; // No log yet: an empty store is the correct starting state.
    }
    for (const line of contents.split("\n")) {
      if (line.trim() === "") continue;
      let entry: LogEntry<T>;
      try {
        entry = JSON.parse(line) as LogEntry<T>;
      } catch {
        // A process killed mid-write leaves a partial final line. It was
        // never acknowledged, so dropping it is correct — and it must not
        // take the rest of the log with it.
        continue;
      }
      this.index.set(entry.key, entry.value);
    }
  }

  get(key: string): T | undefined {
    return this.index.get(key);
  }

  set(key: string, value: T): void {
    const entry: LogEntry<T> = { key, value, at: new Date().toISOString() };
    writeSync(this.fd, `${JSON.stringify(entry)}\n`);
    // Without this the write sits in the page cache and a power loss
    // takes it, which is the one moment this store has to be trusted.
    fsyncSync(this.fd);
    this.index.set(key, value);
  }

  close(): void {
    closeSync(this.fd);
  }
}

export interface ClosableJobStore extends JobStore {
  close(): void;
}
export interface ClosablePaidStore extends PaidStore {
  close(): void;
}

export function createFileJobStore(path: string): ClosableJobStore {
  const log = new AppendLog<Job>(path);
  return {
    get: (id) => log.get(id),
    set: (job) => log.set(job.id, job),
    close: () => log.close(),
  };
}

export function createFilePaidStore(path: string): ClosablePaidStore {
  const log = new AppendLog<{ jobId: string; settled: boolean }>(path);
  return {
    get: (nonce) => log.get(nonce),
    set: (nonce, value) => log.set(nonce, value),
    close: () => log.close(),
  };
}
