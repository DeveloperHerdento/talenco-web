// Liveness check for the Docker/compose healthcheck. Deliberately touches no dependency
// (Supabase, Redis, payment-service are external) and does not import lib/env.ts.
export const dynamic = "force-dynamic";

export function GET() {
  return Response.json({ status: "ok" });
}
