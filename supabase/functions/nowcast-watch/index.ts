import { createWeatherWatchHandler } from '../_shared/weather-watch/http.ts';
Deno.serve(createWeatherWatchHandler(['rain'], Deno.env));
