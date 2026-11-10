export type CheckoutIntentItem = {
  id: string;
  catalogItemId: string;
  title: string;
  quantity: number;
  unitAmount: string;
};

export type CheckoutIntentSnapshot = {
  amount: string;
  currency: 'PEN';
  items: CheckoutIntentItem[];
  orderStatus: 'confirmed' | 'reserved';
  orderRevision: string;
  reservationExpiresAt: string | null;
  gatewayRevision: string;
};

export type PaymentCheckoutIntent = CheckoutIntentSnapshot & {
  id: string;
  externalReference: string;
  orderId: string;
  gatewayId: string;
  state: 'prepared' | 'voided';
  version: number;
  voidReason: 'operator_cancelled' | 'voucher_validated' | null;
};
