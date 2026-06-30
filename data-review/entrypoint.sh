#!/bin/sh
# Container start. Two modes:
#  - baked: data.json + flags.parquet are in the image -> serve immediately (fast
#    start; reliable App Runner health check). Refresh data by rebuilding the image.
#  - build-at-start: no baked artifacts -> sync inputs from S3 and build, then serve.
# Vetting persists to Atlas (MONGODB_URI), so the container filesystem stays ephemeral.
set -eu
SCRATCH="${DATA_REVIEW_SCRATCH:-/scratch}"
BUILT="${DATA_REVIEW_S3_BUILT:-s3://error-review/built}"
BUILT="${BUILT%/}"
REGION_ARG=""
[ -n "${AWS_REGION:-}" ] && REGION_ARG="--region ${AWS_REGION}"

# Prefer the freshly PREBUILT artifacts from S3 (built off-box by CodeBuild on
# each data upload). Fall back to artifacts baked into the image, then to a full
# in-container build as a last resort. (`if` conditions are exempt from set -e,
# so a missing prebuilt object cleanly falls through instead of aborting.)
if aws s3 cp "$BUILT/data.json" /app/data.json $REGION_ARG \
   && aws s3 cp "$BUILT/flags.parquet" /app/flags.parquet $REGION_ARG; then
  echo "[entrypoint] using prebuilt artifacts from $BUILT"
elif [ -f /app/data.json ] && [ -f /app/flags.parquet ]; then
  echo "[entrypoint] prebuilt unavailable -- using baked artifacts"
else
  echo "[entrypoint] no prebuilt or baked artifacts -- building in-container"
  python /app/fetch_inputs.py \
    --chainlinked-uri "$DATA_REVIEW_S3_CHAINLINKED" \
    --gmd-uri "$DATA_REVIEW_S3_GMD" \
    --helpers-uri "$DATA_REVIEW_S3_HELPERS" \
    --dest "$SCRATCH" $REGION_ARG
  export DATA_REVIEW_DATA_ROOT="$SCRATCH"
  python /app/flags.py
  python /app/build_data.py
fi

echo "[entrypoint] serving on 0.0.0.0:${PORT:-8080}"
exec python /app/serve.py "${PORT:-8080}"
