import { describe, it, expect, vi, beforeEach } from "vitest";
import { createHmac } from "crypto";
import type { NextRequest } from "next/server";

type Row = Record<string, unknown>;
const db = vi.hoisted(() => ({ registrations: [] as Row[], events: new Set<string>() }));

vi.mock("@/lib/env", () => ({ env: { paymentWebhookSecret: "whsec_test", appUrl: "https://talenco.test" } }));
vi.mock("@/lib/ratelimit", () => ({ webhookLimiter: { limit: async () => ({ success: true }) } }));
vi.mock("@/lib/emails/payment", () => ({ sendPaidEmail: vi.fn() }));

// Just enough of the supabase-js query builder for the webhook's three queries.
vi.mock("@/lib/supabase", () => {
  const filtered = (filters: ((r: Row) => boolean)[]) => db.registrations.filter((r) => filters.every((f) => f(r)));
  return {
    supabase: {
      from(table: string) {
        if (table === "processed_payment_events") {
          return {
            insert: async ({ id }: { id: string }) => {
              if (db.events.has(id)) return { error: { code: "23505", message: "duplicate key" } };
              db.events.add(id);
              return { error: null };
            },
          };
        }
        const filters: ((r: Row) => boolean)[] = [];
        let patch: Row | null = null;
        const builder = {
          select: () => builder,
          update: (values: Row) => ((patch = values), builder),
          eq: (col: string, val: unknown) => (filters.push((r) => r[col] === val), builder),
          lt: (col: string, val: number) => (filters.push((r) => (r[col] as number) < val), builder),
          maybeSingle: async () => ({ data: filtered(filters)[0] ?? null, error: null }),
          then: (resolve: (v: unknown) => void) => {
            for (const r of filtered(filters)) Object.assign(r, patch);
            resolve({ error: null });
          },
        };
        return builder;
      },
    },
  };
});

import { POST } from "./route";
import { sendPaidEmail } from "@/lib/emails/payment";

function event(id: string, type: string, status: string, version: number) {
  return {
    id,
    type,
    created_at: new Date().toISOString(),
    data: {
      order: {
        id: "ord_1",
        app_order_id: "reg-1",
        type: "ONE_TIME",
        status,
        version,
        installments: [],
        payments: status === "COMPLETED" ? [{ status: "SUCCEEDED", paid_at: "2026-10-14T03:00:00Z" }] : [],
      },
    },
  };
}

function deliver(body: unknown, secret = "whsec_test") {
  const raw = JSON.stringify(body);
  const ts = String(Math.floor(Date.now() / 1000));
  const sig = createHmac("sha256", secret).update(`${ts}.${raw}`).digest("hex");
  const req = new Request("https://talenco.test/api/payments/webhook", {
    method: "POST",
    headers: { "x-timestamp": ts, "x-signature": `v1=${sig}` },
    body: raw,
  });
  return POST(req as unknown as NextRequest);
}

beforeEach(() => {
  db.events.clear();
  db.registrations = [
    {
      id: "reg-1",
      email: "a@example.com",
      full_name: "A",
      locale: "ja",
      access_token: "tok",
      status: "pending",
      payment_order_id: "ord_1",
      payment_status: null,
      payment_version: 0,
      installments_paid: 0,
    },
  ];
  vi.mocked(sendPaidEmail).mockClear();
});

describe("POST /api/payments/webhook", () => {
  it("rejects a bad signature with 401 and changes nothing", async () => {
    const res = await deliver(event("evt_1", "payment.succeeded", "COMPLETED", 2), "whsec_wrong");
    expect(res.status).toBe(401);
    expect(db.registrations[0].payment_status).toBeNull();
  });

  it("mirrors a completed order and sends the receipt once across redeliveries", async () => {
    const evt = event("evt_1", "payment.succeeded", "COMPLETED", 2);
    expect((await deliver(evt)).status).toBe(200);
    expect((await deliver(evt)).status).toBe(200);

    expect(db.registrations[0]).toMatchObject({ payment_status: "paid", payment_version: 2, status: "paid" });
    expect(sendPaidEmail).toHaveBeenCalledTimes(1);
  });

  it("ignores an older version arriving after a newer one", async () => {
    await deliver(event("evt_2", "order.completed", "COMPLETED", 3));
    const res = await deliver(event("evt_1", "checkout.expired", "EXPIRED", 1));

    expect(res.status).toBe(200);
    expect(db.registrations[0]).toMatchObject({ payment_status: "paid", payment_version: 3 });
  });
});
