import "server-only";

import { createHmac } from "crypto";
import { env } from "@/lib/env";
import { timingSafeStringEqual } from "@/lib/timing-safe";

// Contract: payment-service/docs/integration/CONTRACT.md

export type OrderStatus = "AWAITING_PAYMENT" | "ACTIVE" | "COMPLETED" | "PAST_DUE" | "CANCELED" | "EXPIRED";
export type InstallmentStatus = "SCHEDULED" | "PROCESSING" | "PAID" | "FAILED";

export type OrderView = {
  id: string;
  app_order_id: string;
  type: "ONE_TIME" | "INSTALLMENT" | "SUBSCRIPTION";
  status: OrderStatus;
  currency: string;
  total_amount: number;
  version: number;
  installments: { seq: number; amount: number; due_date: string; status: InstallmentStatus; attempt: number; next_attempt_at: string | null }[];
  payments: {
    id: string;
    status: string;
    amount: number;
    currency: string;
    installment_seqs: number[];
    failure_code: string | null;
    paid_at: string | null;
    invoice_no: string | null;
  }[];
  card: { brand: string | null; last4: string | null };
  created_at: string;
  updated_at: string;
};

export type CheckoutRequest = {
  type: "ONE_TIME" | "INSTALLMENT";
  app_order_id: string;
  amount: number;
  currency?: "IDR" | "USD" | "JPY";
  description?: string;
  customer: { id: string; email: string; name?: string; phone?: string };
  mode?: "COMPONENTS" | "LINK";
  return_url?: string;
  installments?: { seq: number; amount: number; due_date: string }[];
  metadata?: Record<string, unknown>;
};

export type CheckoutResponse = {
  order_id: string;
  app_order_id: string;
  type: CheckoutRequest["type"];
  status: OrderStatus;
  amount_due_now: number;
  currency: string;
  components_sdk_key: string | null;
  payment_link_url: string | null;
  expires_at: string;
};

export type ChargeResponse =
  | { kind: "CHARGE"; payment_id: string; amount: number; status: "PROCESSING" }
  | { kind: "RECOVERY"; payment_link_url: string; components_sdk_key: string; expires_at: string };

export type CardSessionResponse = { components_sdk_key: string; payment_link_url: string; expires_at: string };

export class PaymentServiceError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string
  ) {
    super(message);
  }
}

async function call<T>(method: "GET" | "POST", path: string, body?: unknown): Promise<T> {
  const res = await fetch(`${env.paymentServiceUrl}${path}`, {
    method,
    headers: { "x-app-key": env.paymentAppKey, ...(body ? { "Content-Type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(15_000),
    cache: "no-store",
  });
  const json = await res.json().catch(() => null);
  if (!res.ok) {
    throw new PaymentServiceError(res.status, json?.error?.code ?? "UNKNOWN", json?.error?.message ?? res.statusText);
  }
  return json as T;
}

export const createCheckout = (req: CheckoutRequest) => call<CheckoutResponse>("POST", "/v1/checkouts", req);

export const getOrder = (orderId: string) => call<OrderView>("GET", `/v1/orders/${encodeURIComponent(orderId)}`);

export const getOrderByAppOrderId = (appOrderId: string) =>
  call<OrderView>("GET", `/v1/orders?app_order_id=${encodeURIComponent(appOrderId)}`);

export const chargeNow = (orderId: string, mode: "next" | "all") =>
  call<ChargeResponse>("POST", `/v1/orders/${encodeURIComponent(orderId)}/charge`, { mode });

export const openCardSession = (orderId: string) =>
  call<CardSessionResponse>("POST", `/v1/orders/${encodeURIComponent(orderId)}/card-session`, {});

const MAX_SKEW_SECONDS = 300;

// x-signature: "v1=<hex>[,v1=<hex>]" — two values during secret rotation, either may match.
export function verifyPaymentEvent(raw: string, ts: string | null, sig: string | null): boolean {
  if (!ts || !sig || !/^\d+$/.test(ts) || Math.abs(Date.now() / 1000 - Number(ts)) > MAX_SKEW_SECONDS) return false;
  const expected = createHmac("sha256", env.paymentWebhookSecret).update(`${ts}.${raw}`).digest("hex");
  return sig.split(",").some((part) => timingSafeStringEqual(part.trim().replace(/^v1=/, ""), expected));
}
