import { createWebhookHandler } from "../src/webhook.js";

const handleWebhook = createWebhookHandler();

export function GET() {
  return Response.json(
    { ok: true, service: "telegram-impostor-webhook" },
    { headers: { "cache-control": "no-store" } },
  );
}

export async function POST(request) {
  return handleWebhook(request);
}
