#!/bin/bash
# ══════════════════════════════════════════════════════════════════
# WW3 Pre-Cache Cron Job
# 
# Runs every 6 hours to download the latest WaveWatch III forecast
# from NOAA NOMADS, decode the GRIB2 data, and upload JSON shards
# to Supabase Storage for the 4D passage planner.
#
# Cron schedule (add to crontab with: crontab -e):
#   15 0,6,12,18 * * * /path/to/backend/ww3_cron.sh >> /var/log/ww3_cron.log 2>&1
#
# Runs at :15 past each cycle to allow time for NOAA to process.
# ══════════════════════════════════════════════════════════════════

set -euo pipefail

# Navigate to backend directory
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$SCRIPT_DIR"

# Activate virtual environment if present
if [ -f "venv/bin/activate" ]; then
    source venv/bin/activate
fi

# Required environment variables:
#   SUPABASE_URL         — Supabase project URL
#   SUPABASE_SERVICE_KEY  — Supabase service role key (for storage writes)

echo "═══════════════════════════════════════════════"
echo "WW3 Pre-Cache Cron — $(date -u '+%Y-%m-%d %H:%M UTC')"
echo "═══════════════════════════════════════════════"

python3 ww3_precache.py 2>&1

EXIT_CODE=$?

if [ $EXIT_CODE -eq 0 ]; then
    echo "✓ WW3 pre-cache completed successfully"
else
    echo "✗ WW3 pre-cache failed with exit code $EXIT_CODE"
fi

exit $EXIT_CODE
