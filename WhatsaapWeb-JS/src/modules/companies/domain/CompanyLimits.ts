/**
 * Límites efectivos de una compañía (pueden derivarse del plan + overrides).
 */
export interface CompanyLimits {
  readonly companyId: number;
  readonly maxUsers: number;
  readonly maxConversations: number;
  readonly maxMessagesPerMonth: number;
}
