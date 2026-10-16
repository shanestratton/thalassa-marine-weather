import { createTelegramWebhook } from './handler.ts';
Deno.serve(createTelegramWebhook(Deno.env));
