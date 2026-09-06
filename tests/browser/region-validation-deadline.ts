/** Test-harness deadlines use actual monotonic time as well as timer wakeups.
 * A delayed timer callback must not let an overdue result become passing evidence. */
export class RegionValidationDeadline {
  constructor(readonly overallDeadline: number, private readonly now: () => number = () => performance.now()) {}

  assertOpen(deadline = this.overallDeadline): void {
    if (this.now() >= Math.min(deadline, this.overallDeadline)) throw new Error('Region validation deadline exceeded.');
  }

  /** The thunk is admitted before it starts. The original operation remains the
   * caller's responsibility if this wait expires; no deadline cancels ownership. */
  bounded<T>(start: () => Promise<T>, milliseconds = 10_000): Promise<T> {
    return this.waitUntil(start, Math.min(this.overallDeadline, this.now() + milliseconds));
  }

  private async waitUntil<T>(start: () => Promise<T>, deadline: number): Promise<T> {
    this.assertOpen(deadline);
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const operation = start();
      const result = await Promise.race([operation, new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('Region validation deadline exceeded.')), Math.max(0, deadline - this.now()));
      })]);
      this.assertOpen(deadline);
      return result;
    } finally { clearTimeout(timer); }
  }

  /** Shared by coordinator drive and settlement loops. One absolute stage deadline
   * covers every RAF, any following advance, and acceptance of the done predicate. */
  async stage(options: { readonly milliseconds: number; readonly done: () => boolean;
    readonly wait: () => Promise<void>; readonly advance?: () => void }): Promise<void> {
    const deadline = Math.min(this.overallDeadline, this.now() + options.milliseconds);
    for (;;) {
      this.assertOpen(deadline);
      const done = options.done();
      this.assertOpen(deadline);
      if (done) return;
      await this.waitUntil(options.wait, deadline);
      this.assertOpen(deadline);
      if (options.advance) {
        this.assertOpen(deadline);
        options.advance();
        this.assertOpen(deadline);
      }
    }
  }
}
