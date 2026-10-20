import assert from "node:assert/strict";
import { suite, test } from "mocha";
import { PerDocumentRefreshScheduler, type RefreshTimer } from "../../src/refresh-scheduler";

class FakeTimers implements RefreshTimer {
  private nextId = 0;
  private now = 0;
  private readonly scheduled = new Map<number, { at: number; callback: () => void }>();

  setTimeout(callback: () => void, delayMs: number): unknown {
    const id = this.nextId++;
    this.scheduled.set(id, { at: this.now + delayMs, callback });
    return id;
  }

  clearTimeout(handle: unknown): void {
    this.scheduled.delete(handle as number);
  }

  advance(ms: number): void {
    this.now += ms;
    let due = [...this.scheduled.entries()].filter(([, timer]) => timer.at <= this.now);
    while (due.length) {
      for (const [id, timer] of due) {
        this.scheduled.delete(id);
        timer.callback();
      }
      due = [...this.scheduled.entries()].filter(([, timer]) => timer.at <= this.now);
    }
  }

  get size(): number { return this.scheduled.size; }
}

suite("per-document refresh scheduling", () => {
  test("coalesces each document independently without canceling other documents", () => {
    const timers = new FakeTimers();
    const scheduler = new PerDocumentRefreshScheduler(75, timers);
    const refreshed: string[] = [];
    scheduler.schedule("first.ts", () => refreshed.push("first-old"));
    timers.advance(40);
    scheduler.schedule("second.ts", () => refreshed.push("second"));
    timers.advance(10);
    scheduler.schedule("first.ts", () => refreshed.push("first-new"));

    timers.advance(65);
    assert.deepEqual(refreshed, ["second"]);
    timers.advance(10);
    assert.deepEqual(refreshed, ["second", "first-new"]);
    assert.equal(timers.size, 0);
  });

  test("cancel and dispose clear pending document work", () => {
    const timers = new FakeTimers();
    const scheduler = new PerDocumentRefreshScheduler(75, timers);
    let calls = 0;
    scheduler.schedule("closed.ts", () => calls++);
    scheduler.cancel("closed.ts");
    scheduler.schedule("other.ts", () => calls++);
    scheduler.dispose();
    timers.advance(100);
    assert.equal(calls, 0);
    assert.equal(timers.size, 0);
  });
});
