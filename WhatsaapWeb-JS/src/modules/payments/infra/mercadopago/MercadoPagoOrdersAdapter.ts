import type { PaymentCheckoutIntent } from '../../domain/paymentCheckoutIntent.types';

const ordersUrl = 'https://api.mercadopago.com/v1/orders';
const checkoutOrigin = 'https://www.mercadopago.com.pe';
const uuid = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;
const providerOrderId = /^ORD(?:TST)?[0-9A-HJKMNP-TV-Z]{26}$/;
const providerPaymentId = /^PAY[0-9A-HJKMNP-TV-Z]{26}$/;
const positiveId = /^[1-9][0-9]{0,18}$/;
const requestTimeoutMs = 5_000;
const dispatchWindowMs = 5_000;
const expiryMarginMs = 15_000;
const maxCheckoutWindowMs = 24 * 60 * 60 * 1000;
const maxResponseBytes = 128 * 1024;

export function isMercadoPagoOrderId(value: unknown): value is string {
  return typeof value === 'string' && providerOrderId.test(value);
}

type GatewayScope = {
  companyId: number;
  gatewayId: string;
  gatewayRevision: string;
};
type GatewayCredential = GatewayScope & { sellerId: string; accessToken: string };
type OrdersTransport = (url: URL, request: RequestInit) => Promise<Response>;
type OrdersContext = { companyId: number; intent: PaymentCheckoutIntent };
type CreateInput = OrdersContext & { plannedAt: number; validUntil: number };
type LookupInput = OrdersContext & { orderId: string; validUntil: number };
type NotSent = { kind: 'not_sent'; reason: 'invalid_snapshot' | 'invalid_window' | 'credential_unavailable' };
type Uncertain = { kind: 'uncertain'; reason: 'transport' | 'response' | 'checkout_unverified'; status?: number; orderId?: string };
type Rejected = { kind: 'rejected'; status: number; code: string };
type Created = { kind: 'created'; orderId: string; checkoutUrl: string; expiresAt: string };
type PaymentObservation = 'unpaid' | 'pending' | 'failed' | 'partial' | 'paid_candidate' | 'reconciliation_required';
type Observed = {
  kind: 'observed'; orderId: string; status: string; statusDetail: string; amountPaid: string; payment: PaymentObservation;
  providerPayment: PaymentObservation; providerExpiresAt: number | undefined;
};

const validationErrors = new Set([
  'empty_required_header', 'invalid_idempotency_key_length', 'required_properties',
  'order_items_total_amount_mismatch', 'invalid_total_amount', 'unsupported_properties',
  'property_value', 'property_type', 'json_syntax_error', 'minimum_properties', 'invalid_email_for_sandbox',
]);

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function cents(value: unknown): bigint | undefined {
  if (typeof value !== 'string' || !/^(?:0|[1-9]\d{0,9})(?:\.\d{1,2})?$/.test(value)) return undefined;
  const [whole, fraction = ''] = value.split('.');
  return BigInt(whole) * 100n + BigInt(fraction.padEnd(2, '0'));
}

function validContext({ companyId, intent }: OrdersContext) {
  if (!Number.isSafeInteger(companyId) || companyId <= 0 ||
      typeof intent.id !== 'string' || !uuid.test(intent.id) ||
      typeof intent.externalReference !== 'string' || !uuid.test(intent.externalReference) ||
      typeof intent.gatewayId !== 'string' || !positiveId.test(intent.gatewayId) ||
      !intent.gatewayRevision || intent.currency !== 'PEN') return false;
  const amount = cents(intent.amount);
  if (!amount || !Array.isArray(intent.items) || !intent.items.length) return false;
  let total = 0n;
  for (const line of intent.items) {
    if (!line || typeof line.title !== 'string') return false;
    const unit = cents(line.unitAmount);
    if (!unit || !line.title.trim() || !Number.isSafeInteger(line.quantity) || line.quantity <= 0) return false;
    total += unit * BigInt(line.quantity);
  }
  return total === amount;
}

function checkoutDuration(input: CreateInput, now: number): number | undefined {
  const { plannedAt, validUntil, intent } = input;
  if (!Number.isSafeInteger(plannedAt) || !Number.isSafeInteger(validUntil) ||
      plannedAt > now || now - plannedAt > dispatchWindowMs || validUntil - plannedAt > maxCheckoutWindowMs) return;
  if (intent.reservationExpiresAt !== null) {
    const deadline = Date.parse(intent.reservationExpiresAt);
    if (!Number.isFinite(deadline) || validUntil > deadline) return;
  }
  const seconds = Math.floor((validUntil - plannedAt - expiryMarginMs) / 1000);
  return seconds > 0 ? seconds : undefined;
}

function durationMs(value: unknown): number | undefined {
  if (typeof value !== 'string') return;
  const duration = /^P(?:(\d{1,4})D)?(?:T(?:(\d{1,4})H)?(?:(\d{1,4})M)?(?:(\d{1,6})S)?)?$/.exec(value);
  if (!duration) return;
  const [, days = '0', hours = '0', minutes = '0', seconds = '0'] = duration;
  const ms = (((Number(days) * 24 + Number(hours)) * 60 + Number(minutes)) * 60 + Number(seconds)) * 1000;
  return ms > 0 ? ms : undefined;
}

function providerExpiry(order: Record<string, unknown>): number | undefined {
  if (typeof order.created_date !== 'string' ||
      !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(order.created_date)) return;
  const created = Date.parse(order.created_date);
  const duration = durationMs(order.expiration_time);
  return Number.isFinite(created) && duration !== undefined ? created + duration : undefined;
}

function safeCheckoutUrl(value: unknown, orderId: string): string | undefined {
  if (typeof value !== 'string' || value.length > 512 || /[\s\\]/.test(value)) return;
  try {
    const url = new URL(value);
    if (url.origin === checkoutOrigin && !url.username && !url.password && !url.hash &&
        url.pathname === '/checkout/v1/redirect' && url.search === `?order_id=${orderId}`) return url.href;
  } catch {
    return undefined;
  }
}

function matchedOrder(
  value: unknown, context: OrdersContext, credential: GatewayCredential, expectedId?: string,
): (Record<string, unknown> & { id: string }) | undefined {
  const order = record(value);
  if (!order || !isMercadoPagoOrderId(order.id) ||
      (expectedId !== undefined && order.id !== expectedId) || order.type !== 'online' || order.processing_mode !== 'manual' ||
      order.country_code !== 'PER' || order.currency !== 'PEN' || order.user_id !== credential.sellerId ||
      order.external_reference !== context.intent.externalReference || cents(order.total_amount) !== cents(context.intent.amount)) return;
  return { ...order, id: order.id };
}

function rejectedCode(status: number, body: unknown): string | undefined {
  const payload = record(body);
  const codes = Array.isArray(payload?.errors) ? payload.errors.map((item) => record(item)?.code) : [payload?.code];
  const first = codes[0];
  if (typeof first !== 'string' || !codes.every((code) => code === first)) return;
  if ((status === 400 && validationErrors.has(first)) ||
      (status === 401 && first === 'invalid_credentials') ||
      (status === 403 && (first === 'forbidden' || first === 'PA_UNAUTHORIZED_RESULT_FROM_POLICIES'))) return first;
}

async function boundedJson(response: Response): Promise<unknown> {
  if (response.redirected || !response.body || response.body.locked ||
      Number(response.headers.get('content-length')) > maxResponseBytes) {
    await response.body?.cancel().catch(() => undefined);
    return undefined;
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder('utf-8', { fatal: true });
  let bytes = 0;
  let text = '';
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      bytes += chunk.value.length;
      if (bytes > maxResponseBytes) return undefined;
      text += decoder.decode(chunk.value, { stream: true });
    }
    return JSON.parse(text + decoder.decode());
  } catch {
    return undefined;
  } finally {
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}

function creditEvidence(order: Record<string, unknown>): { credited: bigint; unsettled: boolean } | undefined {
  const transactions = record(order.transactions);
  if (order.transactions !== undefined && !transactions) return;
  for (const field of ['refunds', 'chargebacks']) {
    const events = transactions?.[field];
    if (events !== undefined && (!Array.isArray(events) || events.length)) return;
  }
  const payments = transactions?.payments ?? [];
  if (!Array.isArray(payments)) return;
  const ids = new Set<string>();
  let credited = 0n;
  let unsettled = false;
  for (const entry of payments) {
    const payment = record(entry);
    if (!payment || typeof payment.id !== 'string' || !providerPaymentId.test(payment.id) || ids.has(payment.id)) return;
    if (payment.status_detail === 'refunded' || payment.status_detail === 'partially_refunded') return;
    ids.add(payment.id);
    const paid = cents(payment.paid_amount);
    if (payment.status === 'processed' && payment.status_detail === 'accredited') {
      if (!paid || cents(payment.amount) !== paid) return;
      credited += paid;
    } else {
      if (payment.paid_amount !== undefined && paid !== 0n) return;
      if (payment.status === 'created' || payment.status === 'processing' || payment.status === 'action_required') unsettled = true;
      else if (!['failed', 'canceled', 'expired'].includes(String(payment.status))) return;
    }
  }
  return { credited, unsettled };
}

function providerPaymentStatus(order: Record<string, unknown>, total: bigint, paid: bigint): PaymentObservation {
  const evidence = creditEvidence(order);
  if (paid > total || evidence?.credited !== paid || order.status === 'refunded' ||
      order.status_detail === 'partially_refunded' || (paid > 0n && (order.status === 'canceled' || order.status === 'failed'))) {
    return 'reconciliation_required';
  }
  if (paid > 0n && paid < total) {
    return ['processed', 'processing', 'action_required'].includes(String(order.status)) ? 'partial' : 'reconciliation_required';
  }
  if (paid === total) {
    return !evidence.unsettled && order.status === 'processed' && order.status_detail === 'accredited'
      ? 'paid_candidate' : 'reconciliation_required';
  }
  if (order.status === 'created' && order.status_detail === 'created') return 'unpaid';
  if (order.status === 'failed' || (order.status === 'canceled' && order.status_detail === 'canceled')) return 'failed';
  if (order.status === 'processing' || order.status === 'action_required') return 'pending';
  return 'reconciliation_required';
}

export class MercadoPagoOrdersAdapter {
  constructor(
    private readonly transport: OrdersTransport,
    private readonly resolveCredential: (scope: GatewayScope) => Promise<GatewayCredential | null>,
    private readonly now = Date.now,
  ) {}

  async create(input: CreateInput): Promise<Created | Rejected | Uncertain | NotSent> {
    if (!validContext(input) || input.intent.state !== 'prepared') return { kind: 'not_sent', reason: 'invalid_snapshot' };
    const duration = checkoutDuration(input, this.now());
    if (!duration) return { kind: 'not_sent', reason: 'invalid_window' };
    const credential = await this.credential(input);
    if (!credential) return { kind: 'not_sent', reason: 'credential_unavailable' };
    if (!checkoutDuration(input, this.now())) return { kind: 'not_sent', reason: 'invalid_window' };
    const { intent } = input;
    const response = await this.request(ordersUrl, credential, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Idempotency-Key': intent.id },
      body: JSON.stringify({
        type: 'online', processing_mode: 'manual', total_amount: intent.amount,
        external_reference: intent.externalReference, expiration_time: `PT${duration}S`,
        items: intent.items.map((line) => ({ title: line.title, quantity: line.quantity, unit_price: line.unitAmount })),
        config: { payment_method: { not_allowed_types: ['ticket'] } },
      }),
    });
    if (!response) return { kind: 'uncertain', reason: 'transport' };
    const body = await boundedJson(response);
    if (response.status !== 201) {
      const code = rejectedCode(response.status, body);
      return code ? { kind: 'rejected', status: response.status, code } : { kind: 'uncertain', reason: 'response', status: response.status };
    }
    const order = matchedOrder(body, input, credential);
    if (!order) return { kind: 'uncertain', reason: 'response', status: response.status };
    const url = safeCheckoutUrl(order.checkout_url, order.id);
    const expiry = providerExpiry(order);
    const evidence = creditEvidence(order);
    if (!url || expiry === undefined || expiry > input.validUntil || expiry <= this.now() ||
        order.status !== 'created' || order.status_detail !== 'created' || cents(order.total_paid_amount) !== 0n ||
        evidence?.credited !== 0n || evidence.unsettled) {
      return { kind: 'uncertain', reason: 'checkout_unverified', orderId: order.id };
    }
    return { kind: 'created', orderId: order.id, checkoutUrl: url, expiresAt: new Date(expiry).toISOString() };
  }

  async lookup(input: LookupInput): Promise<Observed | Uncertain | NotSent> {
    if (!validContext(input) || !isMercadoPagoOrderId(input.orderId) || !Number.isSafeInteger(input.validUntil) ||
        input.validUntil <= 0) return { kind: 'not_sent', reason: 'invalid_snapshot' };
    const credential = await this.credential(input);
    if (!credential) return { kind: 'not_sent', reason: 'credential_unavailable' };
    const response = await this.request(`${ordersUrl}/${input.orderId}`, credential, { method: 'GET' });
    if (!response) return { kind: 'uncertain', reason: 'transport' };
    const body = await boundedJson(response);
    const order = response.status === 200 ? matchedOrder(body, input, credential, input.orderId) : undefined;
    const paid = cents(order?.total_paid_amount);
    if (!order || paid === undefined || typeof order.status !== 'string' || typeof order.status_detail !== 'string' ||
        !/^[a-z_]{1,48}$/.test(order.status) || !/^[a-z0-9_]{1,64}$/.test(order.status_detail)) {
      return { kind: 'uncertain', reason: 'response', status: response.status };
    }
    const providerPayment = providerPaymentStatus(order, cents(input.intent.amount)!, paid);
    const providerExpiresAt = providerExpiry(order);
    const now = this.now();
    const reservationExpiresAt = input.intent.reservationExpiresAt;
    const withinWindow = input.intent.state === 'prepared' &&
      providerExpiresAt !== undefined && providerExpiresAt <= input.validUntil && providerExpiresAt > now &&
      (reservationExpiresAt === null || Date.parse(reservationExpiresAt) > now);
    return {
      kind: 'observed', orderId: order.id, status: order.status, statusDetail: order.status_detail,
      amountPaid: `${paid / 100n}.${String(paid % 100n).padStart(2, '0')}`,
      providerPayment, providerExpiresAt,
      payment: paid > 0n && !withinWindow ? 'reconciliation_required' : providerPayment,
    };
  }

  private async credential({ companyId, intent }: OrdersContext): Promise<GatewayCredential | null> {
    try {
      const scope = { companyId, gatewayId: intent.gatewayId, gatewayRevision: intent.gatewayRevision };
      const credential = await this.resolveCredential(scope);
      return credential && credential.companyId === scope.companyId && credential.gatewayId === scope.gatewayId &&
        credential.gatewayRevision === scope.gatewayRevision && typeof credential.sellerId === 'string' && positiveId.test(credential.sellerId) &&
        typeof credential.accessToken === 'string' && /^[!-~]{1,512}$/.test(credential.accessToken)
        ? credential : null;
    } catch {
      return null;
    }
  }

  private async request(url: string, credential: GatewayCredential, init: RequestInit): Promise<Response | undefined> {
    try {
      const headers = new Headers(init.headers);
      headers.set('Authorization', `Bearer ${credential.accessToken}`);
      headers.set('Accept', 'application/json');
      return await this.transport(new URL(url), {
        ...init, headers, redirect: 'error', signal: AbortSignal.timeout(requestTimeoutMs),
      });
    } catch {
      return undefined;
    }
  }
}
