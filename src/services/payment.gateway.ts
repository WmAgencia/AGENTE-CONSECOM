/**
 * PaymentGateway — camada de abstração para gateways de pagamento.
 *
 * O fluxo de checkout/webhook só conhece esta interface. O primeiro gateway
 * implementado é o Mercado Pago (Checkout Pro); adicionar Stripe ou outro =
 * implementar a interface e trocar a factory. Nada mais muda.
 *
 * Credenciais ficam SOMENTE no backend (payment_gateways.config ou env) e
 * nunca são expostas ao frontend.
 */

export type PaymentStatus = 'approved' | 'rejected' | 'pending' | 'refunded' | 'cancelled';

export interface CreateCheckoutInput {
  /** id do pagamento no nosso banco (external_reference). */
  externalId: string;
  /** valor cheio do plano (sem desconto aplicado). */
  amount: number;
  /** valor do desconto (cupom) aplicado. */
  discountAmount: number;
  planName: string;
  payerEmail: string;
  /** URL do webhook de pagamento deste backend. */
  notificationUrl?: string;
  backUrl?: string;
}

export interface CheckoutResult {
  ok: boolean;
  /** URL do checkout (o usuário paga aqui). Ausente no modo sandbox. */
  checkoutUrl?: string;
  gatewayPaymentId?: string;
  gatewayPreferenceId?: string;
  error?: string;
}

export interface TransparentPaymentInput {
  externalId: string;
  amount: number;
  planName: string;
  payerEmail: string;
  cpf: string;
  phone?: string;
  paymentMethodId: string;
  cardToken?: string;
  installments?: number;
  issuerId?: string;
  notificationUrl?: string;
  idempotencyKey: string;
}

export interface TransparentPaymentResult {
  ok: boolean;
  status?: PaymentStatus;
  gatewayPaymentId?: string;
  qrCode?: string;
  qrCodeBase64?: string;
  ticketUrl?: string;
  error?: string;
}

export interface PaymentGateway {
  readonly provider: string;
  createCheckout(input: CreateCheckoutInput): Promise<CheckoutResult>;
  createTransparentPayment?(input: TransparentPaymentInput): Promise<TransparentPaymentResult>;
  /** Valida as credenciais (botão "testar conexão" do Master). */
  testConnection(): Promise<{ ok: boolean; error?: string }>;
  /** Interpreta um webhook e devolve o status canônico. */
  parseWebhook(payload: unknown): Promise<{
    gatewayPaymentId?: string;
    /** Nosso id (external_reference) quando o gateway devolve. */
    externalReference?: string;
    status: PaymentStatus;
    raw: unknown;
  }>;
}

function mapStatus(s?: string): PaymentStatus {
  switch (s) {
    case 'approved':
      return 'approved';
    case 'rejected':
    case 'refused':
    case 'rejected_other':
      return 'rejected';
    case 'refunded':
      return 'refunded';
    case 'cancelled':
    case 'cancelled_by_user':
      return 'cancelled';
    default:
      return 'pending';
  }
}

// =============================================================
// Sandbox — simula aprovação imediata (sem credenciais).
// =============================================================
export class SandboxGateway implements PaymentGateway {
  readonly provider = 'sandbox';

  async createCheckout(input: CreateCheckoutInput): Promise<CheckoutResult> {
    const total = Math.max(0, Math.round((input.amount - input.discountAmount) * 100) / 100);
    void total;
    return {
      ok: true,
      checkoutUrl: undefined,
      gatewayPaymentId: `sandbox-${input.externalId}`,
    };
  }

  async testConnection(): Promise<{ ok: boolean; error?: string }> {
    return { ok: true };
  }

  async createTransparentPayment(input: TransparentPaymentInput): Promise<TransparentPaymentResult> {
    return { ok: true, status: 'approved', gatewayPaymentId: `sandbox-${input.externalId}` };
  }

  async parseWebhook(payload: unknown): Promise<{
    gatewayPaymentId?: string;
    externalReference?: string;
    status: PaymentStatus;
    raw: unknown;
  }> {
    const p = (payload ?? {}) as { paymentId?: string; status?: string; externalReference?: string };
    return {
      gatewayPaymentId: typeof p.paymentId === 'string' ? p.paymentId : undefined,
      externalReference:
        typeof p.externalReference === 'string' ? p.externalReference : undefined,
      status: mapStatus(p.status),
      raw: payload,
    };
  }
}

// =============================================================
// Mercado Pago — Checkout Pro (preferências).
// =============================================================
export class MercadoPagoGateway implements PaymentGateway {
  readonly provider = 'mercadopago';
  private accessToken: string;
  private sandbox: boolean;

  constructor(config: { accessToken: string; sandbox?: boolean }) {
    this.accessToken = config.accessToken;
    this.sandbox = config.sandbox ?? false;
  }

  private async api(
    path: string,
    init?: RequestInit,
  ): Promise<{ ok: boolean; status: number; data: unknown }> {
    try {
      const res = await fetch(`https://api.mercadopago.com${path}`, {
        ...init,
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.accessToken}`,
          ...(init?.headers ?? {}),
        },
      });
      let data: unknown = null;
      try {
        data = await res.json();
      } catch {
        /* sem corpo */
      }
      return { ok: res.ok, status: res.status, data };
    } catch (e) {
      return { ok: false, status: 0, data: { error: e instanceof Error ? e.message : 'network_error' } };
    }
  }

  async createCheckout(input: CreateCheckoutInput): Promise<CheckoutResult> {
    const total = Math.max(0, Math.round((input.amount - input.discountAmount) * 100) / 100);
    const body: Record<string, unknown> = {
      items: [
        {
          title: `Plano ${input.planName} — Vyntra`,
          quantity: 1,
          unit_price: total,
          currency_id: 'BRL',
        },
      ],
      payer: { email: input.payerEmail },
      external_reference: input.externalId,
      auto_return: 'approved',
      binary_mode: true,
    };
    if (input.notificationUrl) body.notification_url = input.notificationUrl;
    if (input.backUrl) {
      body.back_urls = { return: input.backUrl, pending: input.backUrl };
    }
    if (this.sandbox) body.purpose = 'sandbox_preference';

    const r = await this.api('/checkout/preferences', {
      method: 'POST',
      body: JSON.stringify(body),
    });
    if (!r.ok) {
      const d = r.data as { message?: string; cause?: Array<{ description?: string }> };
      const cause = d?.cause?.[0]?.description;
      return {
        ok: false,
        error: cause ?? d?.message ?? `Mercado Pago HTTP ${r.status}`,
      };
    }
    const d = r.data as { id?: string; init_point?: string };
    return {
      ok: true,
      checkoutUrl: d.init_point,
      gatewayPaymentId: d.id,
      gatewayPreferenceId: d.id,
    };
  }

  async createTransparentPayment(input: TransparentPaymentInput): Promise<TransparentPaymentResult> {
    const digits = input.cpf.replace(/\D/g, '');
    const body: Record<string, unknown> = {
      transaction_amount: Math.round(input.amount * 100) / 100,
      description: `Plano ${input.planName} — Vyntra`,
      payment_method_id: input.paymentMethodId,
      external_reference: input.externalId,
      payer: {
        email: input.payerEmail,
        identification: { type: 'CPF', number: digits },
      },
    };
    if (input.phone) {
      const phone = input.phone.replace(/\D/g, '');
      body.payer = { ...(body.payer as Record<string, unknown>), phone: { area_code: phone.slice(0, 2), number: phone.slice(2) } };
    }
    if (input.cardToken) body.token = input.cardToken;
    if (input.installments) body.installments = input.installments;
    if (input.issuerId) body.issuer_id = input.issuerId;
    if (input.notificationUrl) body.notification_url = input.notificationUrl;
    const r = await this.api('/v1/payments', {
      method: 'POST',
      headers: { 'X-Idempotency-Key': input.idempotencyKey },
      body: JSON.stringify(body),
    });
    if (!r.ok) {
      const d = r.data as { message?: string; cause?: Array<{ description?: string }> };
      return { ok: false, error: d?.cause?.[0]?.description ?? d?.message ?? `Mercado Pago HTTP ${r.status}` };
    }
    const d = r.data as { id?: number; status?: string; point_of_interaction?: { transaction_data?: { qr_code?: string; qr_code_base64?: string; ticket_url?: string } } };
    const tx = d.point_of_interaction?.transaction_data;
    return {
      ok: true,
      status: mapStatus(d.status),
      gatewayPaymentId: d.id ? String(d.id) : undefined,
      qrCode: tx?.qr_code,
      qrCodeBase64: tx?.qr_code_base64,
      ticketUrl: tx?.ticket_url,
    };
  }

  async testConnection(): Promise<{ ok: boolean; error?: string }> {
    const r = await this.api('/users/me');
    if (r.ok) return { ok: true };
    const d = r.data as { message?: string } | null;
    return { ok: false, error: d?.message ?? `HTTP ${r.status}` };
  }

  async parseWebhook(payload: unknown): Promise<{
    gatewayPaymentId?: string;
    externalReference?: string;
    status: PaymentStatus;
    raw: unknown;
  }> {
    const p = (payload ?? {}) as { type?: string; data?: { id?: string } };
    const paymentId = typeof p?.data?.id === 'string' ? p.data.id : undefined;
    if (!paymentId) return { status: 'pending', raw: payload };
    const r = await this.api(`/v1/payments/${encodeURIComponent(paymentId)}`);
    if (r.ok) {
      const d = r.data as { status?: string; status_detail?: string; external_reference?: string };
      return {
        gatewayPaymentId: paymentId,
        externalReference:
          typeof d.external_reference === 'string' ? d.external_reference : undefined,
        status: mapStatus(d.status),
        raw: payload,
      };
    }
    return { gatewayPaymentId: paymentId, status: 'pending', raw: payload };
  }
}

/**
 * Factory: monta o gateway ativo conforme a configuração gravada pelo Master
 * (payment_gateways). Sem configuração, retorna o Sandbox (simulação).
 */
export function buildGateway(config: {
  provider: string;
  accessToken?: string;
  sandbox?: boolean;
}): PaymentGateway {
  if (config.provider === 'mercadopago' && config.accessToken) {
    return new MercadoPagoGateway({
      accessToken: config.accessToken,
      sandbox: config.sandbox ?? false,
    });
  }
  return new SandboxGateway();
}
