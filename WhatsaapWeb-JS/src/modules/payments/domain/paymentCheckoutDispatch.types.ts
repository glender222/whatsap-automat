export type PaymentCheckoutDispatchState = 'claimed' | 'created' | 'uncertain' | 'rejected' | 'not_sent';

export type PaymentCheckoutDispatch = {
  intentId: string;
  orderId: string;
  intentVersion: number;
  plannedAt: number;
  validUntil: number;
  state: PaymentCheckoutDispatchState;
  providerOrderId: string | null;
  providerExpiresAt: string | null;
  outcomeCode: string | null;
  version: number;
};

export type PaymentCheckoutDispatchOutcome = {
  state: Exclude<PaymentCheckoutDispatchState, 'claimed'>;
  providerOrderId?: string;
  providerExpiresAt?: string;
  outcomeCode?: string;
};
