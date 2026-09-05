/** Structured preview failures keep the failed stage separate from session health. */
export class PreviewError extends Error {
  readonly code: string;
  readonly stage: string;
  readonly details: Readonly<Record<string, unknown>>;

  constructor(code: string, stage: string, message: string, details: Record<string, unknown> = {}) {
    super(message);
    this.name = 'PreviewError';
    this.code = code;
    this.stage = stage;
    this.details = Object.freeze({ ...details });
  }
}
