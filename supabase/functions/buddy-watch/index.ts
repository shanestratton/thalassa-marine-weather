import { createBuddyWatchHandler } from './handler.ts';
Deno.serve(createBuddyWatchHandler(Deno.env));
