import type { IaPauseOverride, IaPauseStatus } from '../domain/runtime.types';
import { IaPauseOverrideRepositoryPg } from '../infra/db/IaPauseOverrideRepositoryPg';
import { emitDashboard } from '../../../sockets/socketEmitter';

const DEFAULT_PAUSE_HOURS = 24;

export class AgentPauseService {
  constructor(private readonly repository: IaPauseOverrideRepositoryPg) {}

  async pause(input: {
    companyId: number;
    conversationId: number;
    chatId?: string | null;
    pausedBy?: number | null;
    reason?: string | null;
    durationHours?: number;
  }): Promise<IaPauseOverride> {
    const hours = Math.min(Math.max(Number(input.durationHours || DEFAULT_PAUSE_HOURS), 1), 168);
    const expiresAt = new Date(Date.now() + hours * 60 * 60 * 1000);
    const override = await this.repository.pause({
      companyId: input.companyId,
      conversationId: input.conversationId,
      pausedBy: input.pausedBy ?? null,
      reason: input.reason ?? null,
      expiresAt,
    });
    emitDashboard('agent:paused', {
      companyId: input.companyId,
      conversationId: input.conversationId,
      chatId: input.chatId || null,
      pausedBy: input.pausedBy ?? null,
      expiresAt: expiresAt.toISOString(),
    });
    return override;
  }

  async resume(companyId: number, conversationId: number, chatId?: string | null): Promise<void> {
    await this.repository.resume(companyId, conversationId);
    emitDashboard('agent:resumed', {
      companyId,
      conversationId,
      chatId: chatId || null,
    });
  }

  async getStatus(companyId: number, conversationId: number): Promise<IaPauseStatus> {
    return this.repository.getStatus(companyId, conversationId);
  }

  async isPaused(companyId: number, chatId: string): Promise<boolean> {
    return this.repository.isPaused(companyId, chatId);
  }

  async purgeExpired(companyId: number): Promise<number> {
    return this.repository.purgeExpired(companyId);
  }
}
