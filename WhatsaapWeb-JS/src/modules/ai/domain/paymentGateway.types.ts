export type PaymentGatewayProvider = 'mercadopago' | 'stripe' | 'paypal' | 'manual' | 'other';

export type PaymentGateway = {
  id: number;
  companyId: number;
  provider: PaymentGatewayProvider;
  displayName: string;
  credentials: Record<string, unknown>;
  webhookSecret: null;
  credentialsStored: boolean;
  webhookSecretStored: boolean;
  checkoutAvailability: 'unavailable';
  status: 'active' | 'inactive' | 'archived';
  isDefault: boolean;
  metadata: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
};

export type PaymentGatewayInput = {
  provider: PaymentGatewayProvider;
  displayName: string;
  credentials?: Record<string, unknown> | null;
  webhookSecret?: string | null;
  status?: Exclude<PaymentGateway['status'], 'archived'>;
  isDefault?: boolean;
  metadata?: Record<string, unknown>;
};

export type PaymentLinkInput = {
  orderId: number;
  amount: number;
  currency: string;
  reference?: string;
};

export type PaymentLinkResult = {
  url: string;
  gatewayPaymentId: string | null;
  expiresAt: string | null;
  raw?: Record<string, unknown>;
};

export type PaymentWebhookEvent = {
  gatewayPaymentId: string | null;
  status: 'pending' | 'approved' | 'rejected' | 'cancelled' | 'unknown';
  amount: number | null;
  currency: string | null;
  reference: string | null;
  raw: Record<string, unknown>;
};

export interface PaymentGatewayPort {
  readonly providerName: string;
  createPaymentLink(input: PaymentLinkInput): Promise<PaymentLinkResult>;
  verifyWebhookSignature(headers: Record<string, string>, body: string): boolean;
  parseWebhookEvent(body: string): PaymentWebhookEvent;
}
