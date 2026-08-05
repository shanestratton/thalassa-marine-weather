FROM node:20-alpine

# RETIRED 2026-04-18. This deliberately valid Dockerfile must never produce a
# runnable image: Railway may auto-discover a Dockerfile even when an operator
# overlooks DEPRECATED.md. The replacement is the scheduled Supabase
# scrape-vessel-metadata Edge Function.
RUN echo "vessel-scraper is retired; do not deploy this Railway service" >&2; exit 78
