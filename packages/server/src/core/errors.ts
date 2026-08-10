/** Errors that map onto HTTP responses with a stable machine-readable code. */
export class SwitchyardError extends Error {
  constructor(
    readonly statusCode: number,
    readonly code: string,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = 'SwitchyardError';
  }
}

export const notFound = (message: string, details?: unknown) =>
  new SwitchyardError(404, 'not_found', message, details);

export const badRequest = (message: string, details?: unknown) =>
  new SwitchyardError(400, 'bad_request', message, details);

export const conflict = (message: string, details?: unknown) =>
  new SwitchyardError(409, 'conflict', message, details);

export const unsupported = (message: string, details?: unknown) =>
  new SwitchyardError(422, 'unsupported', message, details);

/** Configuration problems, surfaced at startup and on config reload. */
export class ConfigError extends Error {
  constructor(
    message: string,
    readonly issues: string[] = [],
  ) {
    super(message);
    this.name = 'ConfigError';
  }

  format(): string {
    if (this.issues.length === 0) return this.message;
    return [`${this.message}`, ...this.issues.map((issue) => `  • ${issue}`)].join('\n');
  }
}
