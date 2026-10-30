import type { PaymentGateway, PaymentLinkInput, PaymentLinkResult } from '../domain/paymentGateway.types';
import { PaymentGatewayRepositoryPg } from '../infra/db/PaymentGatewayRepositoryPg';

export type PaymentLinkGenerationResult = {
  generated: boolean;
  url: string | null;
  voucherId: number | null;
  reason: string;
};

export class AgentPaymentLinkService {
  constructor(private readonly gatewayRepo: PaymentGatewayRepositoryPg) {}

  async getDefaultGateway(companyId: number): Promise<PaymentGateway | null> {
    return this.gatewayRepo.getDefault(companyId);
  }

  async generate(input: {
    companyId: number;
    gatewayId: number;
    request: PaymentLinkInput;
  }): Promise<PaymentLinkResult> {
    const gateway = await this.gatewayRepo.get(input.companyId, input.gatewayId);
    if (!gateway || gateway.status !== 'active') {
      const error = new Error('Pasarela de pago no disponible') as Error & { statusCode?: number };
      error.statusCode = 400;
      throw error;
    }
    return this.delegateToProvider(gateway, input.request);
  }

  private async delegateToProvider(gateway: PaymentGateway, request: PaymentLinkInput): Promise<PaymentLinkResult> {
    switch (gateway.provider) {
      case 'manual':
        return {
          url: String((gateway.metadata as any)?.manualInstructions || 'Coordina el pago manualmente con el cliente.'),
          gatewayPaymentId: null,
          expiresAt: null,
        };
      case 'mercadopago':
      case 'stripe':
      case 'paypal':
      case 'other':
      default: {
        const error = new Error(`Pasarela ${gateway.provider} no implementada aun`) as Error & { statusCode?: number };
        error.statusCode = 501;
        throw error;
      }
    }
  }
}
