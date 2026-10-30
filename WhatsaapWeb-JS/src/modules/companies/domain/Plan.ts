/**
 * Plan de suscripción disponible en la plataforma.
 */
export interface Plan {
  readonly id: number;
  readonly code: string;
  readonly name: string;
  readonly description: string | null;
  readonly maxUsers: number;
  readonly maxConversations: number;
  readonly maxMessagesPerMonth: number;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}
