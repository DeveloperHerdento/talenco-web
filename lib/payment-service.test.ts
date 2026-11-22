import { describe, it, expect, vi } from "vitest";
import { createHmac } from "crypto";

vi.mock("@/lib/env", () => ({ env: { paymentWebhookSecret: "whsec_test" } }));

import { verifyPaymentEvent } from "./payment-service";

const sign = (secret: string, ts: string, raw: string) => createHmac("sha256", secret).update(`${ts}.${raw}`).digest("hex");
const now = () => String(Math.floor(Date.now() / 1000));
const raw = JSON.stringify({ id: "evt_1", type: "order.completed" });

describe("verifyPaymentEvent", () => {
  it("accepts a valid signature", () => {
    const ts = now();
    expect(verifyPaymentEvent(raw, ts, `v1=${sign("whsec_test", ts, raw)}`)).toBe(true);
  });

  it("rejects a signature made with the wrong secret or over a different body", () => {
    const ts = now();
    expect(verifyPaymentEvent(raw, ts, `v1=${sign("whsec_other", ts, raw)}`)).toBe(false);
    expect(verifyPaymentEvent(raw + " ", ts, `v1=${sign("whsec_test", ts, raw)}`)).toBe(false);
  });

  it("accepts when either of two rotated signatures matches", () => {
    const ts = now();
    const good = sign("whsec_test", ts, raw);
    const old = sign("whsec_old", ts, raw);
    expect(verifyPaymentEvent(raw, ts, `v1=${old},v1=${good}`)).toBe(true);
    expect(verifyPaymentEvent(raw, ts, `v1=${good}, v1=${old}`)).toBe(true);
    expect(verifyPaymentEvent(raw, ts, `v1=${old},v1=${sign("whsec_x", ts, raw)}`)).toBe(false);
  });

  it("rejects timestamps outside the 5-minute window", () => {
    const ts = String(Math.floor(Date.now() / 1000) - 301);
    expect(verifyPaymentEvent(raw, ts, `v1=${sign("whsec_test", ts, raw)}`)).toBe(false);
  });

  it("rejects missing headers and non-numeric timestamps", () => {
    const ts = now();
    expect(verifyPaymentEvent(raw, null, `v1=${sign("whsec_test", ts, raw)}`)).toBe(false);
    expect(verifyPaymentEvent(raw, ts, null)).toBe(false);
    expect(verifyPaymentEvent(raw, "abc", `v1=${sign("whsec_test", "abc", raw)}`)).toBe(false);
  });
});
