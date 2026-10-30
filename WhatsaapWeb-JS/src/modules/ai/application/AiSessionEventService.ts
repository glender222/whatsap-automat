import { emitDashboard, emitToRoom } from '../../../sockets/socketEmitter';
import {
  AiSessionRepositoryPg,
  CreateSessionEventInput,
} from '../infra/db/AiSessionRepositoryPg';

const SECRET_KEYS = /token|secret|password|authorization|api[_-]?key|cookie|set-cookie|access_token|refresh_token/i;
const MAX_STRING_LENGTH = 800;
const MAX_JSON_BYTES = 6000;

export class AiSessionEventService {
  constructor(private readonly repo: AiSessionRepositoryPg) {}

  sanitize(value: unknown): Record<string, unknown> {
    const sanitized = this.sanitizeValue(value, 0);
    if (!sanitized || typeof sanitized !== 'object' || Array.isArray(sanitized)) {
      return { value: sanitized as unknown };
    }
    const asObject = sanitized as Record<string, unknown>;
    const serialized = JSON.stringify(asObject);
    if (serialized.length <= MAX_JSON_BYTES) return asObject;
    return {
      truncated: true,
      bytes: serialized.length,
      preview: serialized.slice(0, MAX_JSON_BYTES),
    };
  }

  async record(input: CreateSessionEventInput): Promise<void> {
    const payload = {
      ...input,
      input: this.sanitize(input.input || {}),
      output: this.sanitize(input.output || {}),
    };
    const event = await this.repo.createEvent(payload);
    const socketPayload = {
      companyId: input.companyId,
      chatId: input.chatId || null,
      sessionId: input.sessionId,
      turnId: input.turnId || null,
      agentId: input.agentId ?? null,
      domainKey: input.domainKey,
      isTest: Boolean(input.isTest),
      event,
    };
    emitDashboard('agent:activity_event', socketPayload);
    if (input.chatId) emitToRoom(input.chatId, 'agent:activity_event', socketPayload);
  }

  private sanitizeValue(value: unknown, depth: number): unknown {
    if (depth > 5) return '[Max depth]';
    if (value === null || value === undefined) return value;
    if (typeof value === 'string') {
      return value.length > MAX_STRING_LENGTH ? `${value.slice(0, MAX_STRING_LENGTH)}...` : value;
    }
    if (typeof value === 'number' || typeof value === 'boolean') return value;
    if (Array.isArray(value)) return value.slice(0, 50).map((item) => this.sanitizeValue(item, depth + 1));
    if (typeof value === 'object') {
      const output: Record<string, unknown> = {};
      for (const [key, child] of Object.entries(value as Record<string, unknown>).slice(0, 80)) {
        output[key] = SECRET_KEYS.test(key) ? '[REDACTED]' : this.sanitizeValue(child, depth + 1);
      }
      return output;
    }
    return String(value);
  }
}
