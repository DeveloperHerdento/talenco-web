import { NextRequest } from "next/server";
import { z } from "zod";
import { supabase } from "@/lib/supabase";
import { statusLimiter } from "@/lib/ratelimit";
import { getOrder } from "@/lib/payment-service";
import { getClientIp } from "@/lib/request";
import { logger } from "@/lib/logger";

const schema = z.object({ token: z.string().uuid() });

// Polled by the browser after Components reports session-complete. Read-through to the service
// so the UI doesn't wait on webhook delivery; the Supabase mirror still only changes via events.
export async function GET(request: NextRequest) {
  const { success: allowed } = await statusLimiter.limit(getClientIp(request));
  if (!allowed) {
    return Response.json({ error: "Too many requests" }, { status: 429 });
  }

  const result = schema.safeParse({ token: request.nextUrl.searchParams.get("token") });
  if (!result.success) {
    return Response.json({ error: "Invalid request" }, { status: 400 });
  }

  const { data: reg } = await supabase
    .from("registrations")
    .select("payment_order_id")
    .eq("access_token", result.data.token)
    .maybeSingle();

  if (!reg?.payment_order_id) {
    return Response.json({ error: "Not found" }, { status: 404 });
  }

  try {
    const order = await getOrder(reg.payment_order_id);
    return Response.json({ status: order.status });
  } catch (err) {
    logger.error("Order status: payment service lookup failed", { orderId: reg.payment_order_id, error: String(err) });
    return Response.json({ error: "Lookup failed" }, { status: 502 });
  }
}
