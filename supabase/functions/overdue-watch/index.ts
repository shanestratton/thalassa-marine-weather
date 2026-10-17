import { createOverdueWorker } from './handler.ts';
Deno.serve(createOverdueWorker(Deno.env));
