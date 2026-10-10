import { env } from "@/lib/env";
import { recordIntegration } from "@/domain/audit";
import { httpJson, ProviderError } from "./http";

export const escapeHtml = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

export async function sendTelegram(chatId: string | undefined, htmlText: string): Promise<string> {
  const token = env.get("TELEGRAM_BOT_TOKEN");
  if (!token || !chatId) throw new ProviderError("not_configured", "Telegram not configured: missing bot token or chat id");
  try {
    const { body } = await httpJson(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, text: htmlText.slice(0, 4000), parse_mode: "HTML", disable_web_page_preview: true }),
    });
    const id = (body as { result?: { message_id?: number } })?.result?.message_id;
    await recordIntegration("telegram", true, "send_message");
    return String(id ?? "");
  } catch (e) {
    await recordIntegration("telegram", false, "send_message", e instanceof Error ? e.message.replace(token, "***") : String(e));
    throw e;
  }
}
