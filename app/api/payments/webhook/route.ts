import { NextRequest } from "next/server";
import { z } from "zod";
import { supabase } from "@/lib/supabase";
import { env } from "@/lib/env";
import { logger } from "@/lib/logger";
import { webhookLimiter } from "@/lib/ratelimit";
import { getClientIp } from "@/lib/request";
import { verifyPaymentEvent, type OrderStatus } from "@/lib/payment-service";
import { sendPaidEmail } from "@/lib/emails/payment";

const eventSchema = z.object({
  id: z.string().min(1),
  type: z.string(),
  data: z.object({
    order: z.object({
      id: z.string(),
      type: z.string(),
      status: z.string(),
      version: z.number().int(),
      installments: z.array(z.object({ status: z.string() })).default([]),
      payments: z.array(z.object({ status: z.string(), paid_at: z.string().nullable() })).default([]),
    }),
  }),
});

type EventOrder = z.infer<typeof eventSchema>["data"]["order"];

const PAYMENT_STATUS: Record<OrderStatus, string | null> = {
  AWAITING_PAYMENT: "pending",
  ACTIVE: "active",
  COMPLETED: "paid",
  PAST_DUE: "past_due",
  CANCELED: "canceled",
  EXPIRED: null,
};

// Derived from the order snapshot, not the event type — events can arrive out of order and
// several can share a version, so the latest snapshot is the only safe source.
function mirrorOf(order: EventOrder) {
  const paymentStatus = PAYMENT_STATUS[order.status as OrderStatus] ?? null;
  const firstPaidAt = order.payments
    .filter((p) => p.status === "SUCCEEDED" && p.paid_at)
    .map((p) => p.paid_at!)
    .sort()[0];
  return {
    payment_status: paymentStatus,
    payment_version: order.version,
    installments_paid: order.installments.filter((i) => i.status === "PAID").length,
    // Legacy column still read by /my, admin and the email unique index.
    ...((paymentStatus === "active" || paymentStatus === "paid") && { status: "paid", paid_at: firstPaidAt ?? new Date().toISOString() }),
  };
}

export async function POST(request: NextRequest) {
  const raw = await request.text();

  if (!verifyPaymentEvent(raw, request.headers.get("x-timestamp"), request.headers.get("x-signature"))) {
    const { success: allowed } = await webhookLimiter.limit(getClientIp(request));
    if (!allowed) return Response.json({ error: "Too many requests" }, { status: 429 });
    logger.warn("Payment event: invalid signature");
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }

  let parsed;
  try {
    parsed = eventSchema.safeParse(JSON.parse(raw));
  } catch {
    parsed = null;
  }
  if (!parsed?.success) {
    // Signed but malformed won't fix itself on retry.
    logger.error("Payment event: malformed payload", { issues: parsed?.error.issues });
    return Response.json({ received: true });
  }

  const event = parsed.data;
  const { order } = event.data;

  const { data: reg, error: fetchErr } = await supabase
    .from("registrations")
    .select("id, email, full_name, locale, access_token")
    .eq("payment_order_id", order.id)
    .maybeSingle();

  if (fetchErr) {
    logger.error("Payment event: registration lookup failed", { eventId: event.id, error: fetchErr.message });
    return Response.json({ error: "Lookup failed" }, { status: 500 });
  }
  if (!reg) {
    // e.g. an expired order a retry already replaced — nothing to mirror.
    logger.warn("Payment event: no registration for order", { eventId: event.id, orderId: order.id, type: event.type });
    return Response.json({ received: true });
  }

  // Mirror first, dedupe second: the version guard makes the update idempotent, so a crash
  // between the two steps is healed by the retry instead of losing the update.
  const { error: mirrorErr } = await supabase
    .from("registrations")
    .update(mirrorOf(order))
    .eq("payment_order_id", order.id)
    .lt("payment_version", order.version);

  if (mirrorErr) {
    logger.error("Payment event: mirror update failed", { eventId: event.id, error: mirrorErr.message });
    return Response.json({ error: "Update failed" }, { status: 500 });
  }

  const { error: dedupeErr } = await supabase.from("processed_payment_events").insert({ id: event.id });
  if (dedupeErr?.code === "23505") {
    return Response.json({ received: true });
  }
  if (dedupeErr) {
    logger.error("Payment event: dedupe insert failed", { eventId: event.id, error: dedupeErr.message });
    return Response.json({ error: "Update failed" }, { status: 500 });
  }

  logger.info("Payment event processed", { eventId: event.id, type: event.type, orderId: order.id, version: order.version });

  const statusUrl = `${env.appUrl}/${reg.locale}/my?token=${reg.access_token}`;
  if (event.type === "payment.succeeded" && order.type === "ONE_TIME") {
    sendPaidEmail(reg.email, reg.full_name, statusUrl);
  }

  return Response.json({ received: true });
}
