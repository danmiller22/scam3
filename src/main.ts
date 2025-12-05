import { Bot, InlineKeyboard, webhookCallback } from "https://deno.land/x/grammy/mod.ts";

const paymentTextEnv = Deno.env.get("PAYMENT_TEXT") ??
  "Оплатите доступ к номеру телефона по указанным реквизитам и нажмите кнопку \"Я оплатил\".";

const token = Deno.env.get("BOT_TOKEN");
const closedChatIdEnv = Deno.env.get("CLOSED_CHAT_ID");
const publicChannelIdEnv = Deno.env.get("PUBLIC_CHANNEL_ID");

// Проверяем, все ли env заданы
const envOk = !!token && !!closedChatIdEnv && !!publicChannelIdEnv;

if (!envOk) {
  console.error(
    "Environment variables are not fully set. Required: BOT_TOKEN, CLOSED_CHAT_ID, PUBLIC_CHANNEL_ID.",
  );
}

// --- утилиты работы с телефонами ---

function normalizePhones(text: string): string[] {
  const phones = new Set<string>();
  const regex = /\+?\d[\d\s\-()]{6,}\d/g;
  const matches = text.match(regex) ?? [];
  for (const raw of matches) {
    const cleaned = raw.replace(/[\s\-()]/g, "");
    if (cleaned.length >= 7) {
      phones.add(cleaned);
    }
  }
  return Array.from(phones);
}

function stripPhones(text: string): string {
  const regex = /\+?\d[\d\s\-()]{6,}\d/g;
  return text.replace(regex, "[номер скрыт]");
}

// Упаковываем телефоны в callback_data (ограничение Telegram 64 байта)
function buildPayload(type: "PAY" | "PAID", phones: string[]): string {
  const base = phones.join(",");
  const encoded = btoa(base);
  const data = `${type}|${encoded}`;
  if (data.length > 64) {
    throw new Error("Too many / too long phone numbers for callback_data");
  }
  return data;
}

function parsePayload(
  data: string,
): { type: "PAY" | "PAID"; phones: string[] } | null {
  const [type, encoded] = data.split("|");
  if (type !== "PAY" && type !== "PAID") return null;
  try {
    const decoded = atob(encoded);
    const phones = decoded.split(",").filter((p) => p.length > 0);
    return { type: type as "PAY" | "PAID", phones };
  } catch {
    return null;
  }
}

// handler для Deno.serve – либо реальный бот, либо заглушка
let handleUpdate: (req: Request) => Promise<Response> | Response;

if (envOk) {
  const CLOSED_CHAT_ID = BigInt(closedChatIdEnv!);
  const PUBLIC_CHANNEL_ID = BigInt(publicChannelIdEnv!);

  const bot = new Bot(token!);

  // Ловим сообщения в закрытой группе
  bot.on("message", async (ctx) => {
    const msg = ctx.message;
    if (!msg || msg.chat.id !== CLOSED_CHAT_ID) return;

    const text = msg.text ?? msg.caption;
    if (!text) return;

    const phones = normalizePhones(text);
    if (phones.length === 0) return;

    const sanitized = stripPhones(text);
    const kb = new InlineKeyboard().text(
      "Показать номер телефона",
      buildPayload("PAY", phones),
    );

    // Текстовое объявление
    if (msg.text) {
      await ctx.api.sendMessage(PUBLIC_CHANNEL_ID, sanitized, {
        reply_markup: kb,
      });
    }
    // Фото + подпись
    else if (msg.photo && msg.photo.length > 0) {
      const photo = msg.photo[msg.photo.length - 1];
      await ctx.api.sendPhoto(PUBLIC_CHANNEL_ID, photo.file_id, {
        caption: sanitized,
        reply_markup: kb,
      });
    }
  });

  // Нажатия на кнопки
  bot.on("callback_query:data", async (ctx) => {
    const data = ctx.callbackQuery.data;
    const payload = parsePayload(data);
    if (!payload) {
      await ctx.answerCallbackQuery({
        text: "Неверные данные кнопки.",
        show_alert: true,
      });
      return;
    }

    const userId = ctx.from?.id;
    if (!userId) {
      await ctx.answerCallbackQuery({
        text: "Не удалось определить пользователя.",
        show_alert: true,
      });
      return;
    }

    if (payload.type === "PAY") {
      // Отправляем инструкции по оплате в личку
      try {
        const kb = new InlineKeyboard().text(
          "Я оплатил",
          buildPayload("PAID", payload.phones),
        );

        await ctx.api.sendMessage(
          userId,
          paymentTextEnv +
            "\n\nПосле оплаты нажмите кнопку \"Я оплатил\", и бот вышлет вам номер телефона.",
          { reply_markup: kb },
        );

        await ctx.answerCallbackQuery({
          text: "Инструкция по оплате отправлена вам в личные сообщения.",
          show_alert: false,
        });
      } catch (_err) {
        await ctx.answerCallbackQuery({
          text: "Напишите боту в личку (/start), затем снова нажмите кнопку в канале.",
          show_alert: true,
        });
      }
    } else if (payload.type === "PAID") {
      // Отправляем номера
      const phonesText = payload.phones.join("\n");
      await ctx.api.sendMessage(
        userId,
        "Номер телефона по объявлению:\n" + phonesText,
      );
      await ctx.answerCallbackQuery({
        text: "Номер отправлен вам в личные сообщения.",
        show_alert: false,
      });
    }
  });

  const grammyHandler = webhookCallback(bot, "std/http");
  handleUpdate = (req: Request) => grammyHandler(req);
} else {
  // Если env нет – деплой не падает, просто заглушка
  handleUpdate = async (_req: Request) =>
    new Response(
      "Bot is not configured. Missing BOT_TOKEN, CLOSED_CHAT_ID or PUBLIC_CHANNEL_ID.",
      { status: 500 },
    );
}

// HTTP-сервер для Deno Deploy
Deno.serve(async (req: Request) => {
  if (req.method === "POST") {
    const url = new URL(req.url);
    if (url.pathname === "/") {
      try {
        return await handleUpdate(req);
      } catch (err) {
        console.error("Error handling update", err);
        return new Response("Internal error", { status: 500 });
      }
    }
  }
  return new Response("OK", { status: 200 });
});
