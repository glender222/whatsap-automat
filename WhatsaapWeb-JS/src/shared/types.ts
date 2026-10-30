/**
 * Shared kernel types for the modular operational core.
 * Must NOT depend on Express, PostgreSQL, WhatsApp, or any adapter.
 */

export type Result<T, E = DomainError> =
  | { ok: true; value: T }
  | { ok: false; error: E };

export class DomainError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly isOperational = true
  ) {
    super(message);
    this.name = 'DomainError';
    Object.setPrototypeOf(this, DomainError.prototype);
  }
}
