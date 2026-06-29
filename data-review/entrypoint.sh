#!/bin/sh
# Container start. Two modes:
#  - baked: data.json + flags.parquet are in the image -> serve immediately (fast
#    start; reliable App Runner health check). Refresh data by rebuilding the image.
#  - build-at-start: no baked artifacts -> sync inputs from S3 and build, then serve.
# Vetting persists to Atlas (MONGODB_URI), so the container filesystem stays ephemeral.
set -eu
SCRATCH="${DATA_REVIEW_SCRATCH:-/scratch}"

if [ -f /app/data.json ] && [ -f /app/flags.parquet ]; then
  echo "[entrypoint] baked artifacts present -- serving directly"
else
  echo "[entrypoint] no baked artifacts -- syncing inputs from S3 + building"
  python /app/fetch_inputs.py \
    --chainlinked-uri "$DATA_REVIEW_S3_CHAINLINKED" \
    --gmd-uri "$DATA_REVIEW_S3_GMD" \
    --helpers-uri "$DATA_REVIEW_S3_HELPERS" \
    --dest "$SCRATCH" ${AWS_REGION:+--region "$AWS_REGION"}
  export DATA_REVIEW_DATA_ROOT="$SCRATCH"
  python /app/flags.py
  python /app/build_data.py
fi

echo "[entrypoint] serving on 0.0.0.0:${PORT:-8080}"
exec python /app/serve.py "${PORT:-8080}"
