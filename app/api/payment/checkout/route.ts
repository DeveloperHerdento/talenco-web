import { NextRequest } from "next/server";
import { z } from "zod";
import { supabase } from "@/lib/supabase";
import { checkoutLimiter } from "@/lib/ratelimit";
import { env } from "@/lib/env";
import { createCheckout, getOrder, PaymentServiceError } from "@/lib/payment-service";
import { getClientIp } from "@/lib/request";
import { logger } from "@/lib/logger";
import { PROGRAM_FEES, XENDIT_CURRENCY, resolveAmount, resolveDisplayAmount } from "@/lib/constants/payment";

const schema = z.object({
  accessToken: z.string().uuid(),
  scheme: z.enum(["online", "onsite"]),
  paymentType: z.enum(["full", "installment"]).default("full"),
});

const FAILED = "決済セッションの作成に失敗しました。/ Failed to start the payment session.";
const IN_PROGRESS =
  "すでに決済手続きが進行中です。しばらくしてからもう一度お試しください。/ A payment is already in progress. Please wait for it to complete or expire, then try again.";

// Expired/canceled orders are final on the service side, so a retry needs a fresh app_order_id.
// Deterministic (reg.id, reg.id:2, reg.id:3…) so concurrent retries collapse onto one order.
function nextAppOrderId(registrationId: string, previous: string): string {
  const n = previous === registrationId ? 1 : Number(previous.split(":").pop());
  return `${registrationId}:${n + 1}`;
}

export async function POST(request: NextRequest) {
  const { success: allowed } = await checkoutLimiter.limit(getClientIp(request));
  if (!allowed) {
    return Response.json(
      { error: "リクエストが多すぎます。しばらくしてからもう一度お試しください。/ Too many requests. Please try again later." },
      { status: 429 }
    );
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "リクエストの形式が正しくありません。/ Invalid request body." }, { status: 400 });
  }

  const result = schema.safeParse(body);
  if (!result.success) {
    return Response.json({ error: "入力内容に誤りがあります / Validation failed" }, { status: 400 });
  }

  const { accessToken, scheme, paymentType } = result.data;

  if (paymentType === "installment") {
    return Response.json({ error: "分割払いは現在準備中です。/ Installments are not available yet." }, { status: 400 });
  }

  const { data: reg, error: fetchErr } = await supabase
    .from("registrations")
    .select("id, email, full_name, locale, status, payment_order_id")
    .eq("access_token", accessToken)
    .maybeSingle();

  if (fetchErr || !reg) {
    return Response.json({ error: "登録情報が見つかりませんでした。/ Registration not found." }, { status: 404 });
  }

  if (reg.status === "paid") {
    return Response.json({ error: "この登録はすでにお支払い済みです。/ This registration is already paid." }, { status: 409 });
  }

  let appOrderId = reg.id;
  try {
    if (reg.payment_order_id) {
      const existing = await getOrder(reg.payment_order_id);
      if (existing.status === "EXPIRED" || existing.status === "CANCELED") {
        appOrderId = nextAppOrderId(reg.id, existing.app_order_id);
      } else if (existing.status === "AWAITING_PAYMENT") {
        appOrderId = existing.app_order_id;
      } else {
        return Response.json({ error: IN_PROGRESS }, { status: 409 });
      }
    }
  } catch (err) {
    logger.error("Checkout: existing order lookup failed", { registrationId: reg.id, error: String(err) });
    return Response.json({ error: FAILED }, { status: 502 });
  }

  const fee = PROGRAM_FEES[scheme];
  const amount = resolveAmount(scheme);

  let checkout;
  try {
    // Every field must be stable across retries — the service treats a changed body for the
    // same app_order_id as ORDER_CONFLICT, hence reg.locale (not the request) and English copy.
    checkout = await createCheckout({
      type: "ONE_TIME",
      app_order_id: appOrderId,
      amount,
      currency: XENDIT_CURRENCY,
      description: `${fee.nameEn} (Full payment)`,
      customer: { id: reg.id, email: reg.email, name: reg.full_name },
      mode: "COMPONENTS",
      return_url: `${env.appUrl}/${reg.locale}/my?token=${accessToken}`,
      metadata: { registrationId: reg.id, scheme },
    });
  } catch (err) {
    if (err instanceof PaymentServiceError && err.status === 409) {
      // Same app_order_id still awaiting payment with a different scheme — refuse rather than
      // open a second payable order.
      return Response.json({ error: IN_PROGRESS }, { status: 409 });
    }
    logger.error("Checkout: payment service create failed", {
      registrationId: reg.id,
      status: err instanceof PaymentServiceError ? err.status : undefined,
      code: err instanceof PaymentServiceError ? err.code : undefined,
      error: String(err),
    });
    return Response.json({ error: FAILED }, { status: 502 });
  }

  const isNewOrder = checkout.order_id !== reg.payment_order_id;
  const { error: updateErr } = await supabase
    .from("registrations")
    .update({
      scheme,
      payment_type: paymentType,
      display_amount: resolveDisplayAmount(scheme),
      ...(isNewOrder && { payment_order_id: checkout.order_id, payment_status: null, payment_version: 0, installments_paid: 0 }),
    })
    .eq("id", reg.id);

  if (updateErr) {
    // Without payment_order_id the webhook can't find this registration — fail before the
    // browser gets a payable session.
    logger.error("Checkout: failed to persist order id", { registrationId: reg.id, orderId: checkout.order_id, error: updateErr.message });
    return Response.json({ error: FAILED }, { status: 502 });
  }

  logger.info("Checkout created", { registrationId: reg.id, orderId: checkout.order_id, appOrderId, scheme, amount });

  return Response.json({
    orderId: checkout.order_id,
    sdkKey: checkout.components_sdk_key,
    expiresAt: checkout.expires_at,
    amount,
    currency: checkout.currency,
  });
}
