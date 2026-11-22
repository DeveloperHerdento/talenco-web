import "server-only";

import { after } from "next/server";
import { env } from "@/lib/env";
import { resend } from "@/lib/resend";
import { htmlEscape } from "@/lib/html";
import { logger } from "@/lib/logger";
import { emailLogoHeader, emailLogoAttachment, emailLineGroupInvite, emailLineGroupAttachment } from "@/lib/emails/layout";

export function sendPaidEmail(to: string, fullName: string, statusUrl: string) {
  const safeName = htmlEscape(fullName);
  // after() keeps the function alive for this send instead of a fire-and-forget promise.
  after(() =>
    resend.emails
      .send({
        from: `TalenCo <${env.resendFromEmail}>`,
        to,
        subject: "【TalenCo】お支払いを確認しました / Payment Received",
        attachments: [emailLogoAttachment, emailLineGroupAttachment],
        html: `
        <div style="font-family:sans-serif;max-width:600px;margin:0 auto;padding:24px">
          ${emailLogoHeader()}
          <h2 style="color:#2081F9">TalenCo グローバルキャリア・スタータープログラム</h2>
          <p>${safeName} 様</p>
          <p>お支払いを確認しました。ありがとうございます。<br/>We've received your payment — thank you!</p>
          <p>近日中に担当者よりプログラムの詳細をご案内します。<br/>Our team will follow up shortly with program details.</p>
          ${emailLineGroupInvite()}
          <div style="background:#f0f7ff;border-radius:8px;padding:16px;margin:20px 0">
            <p style="margin:0 0 8px;font-weight:bold">📋 登録状況の確認 / View Your Registration</p>
            <p style="margin:0 0 12px;font-size:13px;color:#475569">以下のリンクからいつでも登録状況を確認できます。<br/>Use this link anytime to check your registration status.</p>
            <a href="${statusUrl}"
               style="display:inline-block;background:#2081F9;color:white;padding:10px 20px;border-radius:6px;text-decoration:none;font-weight:bold;font-size:14px">
              登録状況を確認する / View My Registration →
            </a>
          </div>
        </div>
      `,
      })
      .catch((err: unknown) => logger.error("Resend: payment confirmation email failed", { error: String(err) }))
  );
}
