#!/usr/bin/env bash
# Manual data refresh for the Data Review app.
#
#   fetch latest S3 data  ->  rebuild data.json + flags.parquet (with Mongo
#   suppression)  ->  bake image  ->  push to ECR  ->  redeploy App Runner.
#
# Use this whenever new data is uploaded to the source bucket, until the
# auto-rebuild-on-upload pipeline is built (deferred). Re-run is idempotent.
#
# Requirements (on the machine you run it from):
#   - aws CLI, authenticated (a session that can read SSM /mongodb/data-review/uri,
#     push to ECR, and call apprunner:StartDeployment)
#   - docker (running)
#   - python with pandas, numpy, pyarrow, pymongo  (pip install pandas numpy pyarrow pymongo dnspython)
#
# Usage:
#   bash deploy/refresh.sh
#   SRC_BUCKET=error-review REGION=ap-southeast-1 bash deploy/refresh.sh   # override defaults
#
set -euo pipefail
export MSYS_NO_PATHCONV=1   # stop Git Bash mangling the /mongodb/... SSM name

SRC_BUCKET="${SRC_BUCKET:-error-review}"
REGION="${REGION:-ap-southeast-1}"
ACCOUNT=566474062827
ECR="$ACCOUNT.dkr.ecr.$REGION.amazonaws.com/data-review"
SERVICE_ARN="arn:aws:apprunner:$REGION:$ACCOUNT:service/data-review/c82e017fb3434a48bcc8b3a56eaab9ed"
SSM_MONGO="/mongodb/data-review/uri"

# data-review/ is the parent of this deploy/ dir.
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DR="$(cd "$HERE/.." && pwd)"
SCRATCH="${SCRATCH:-$DR/_refresh_scratch}"

echo "==> 1/5 fetch  s3://$SRC_BUCKET  ->  $SCRATCH"
rm -rf "$SCRATCH"
python "$DR/fetch_inputs.py" \
  --chainlinked-uri "s3://$SRC_BUCKET/final/" \
  --gmd-uri         "s3://$SRC_BUCKET/final/GMD.dta" \
  --helpers-uri     "s3://$SRC_BUCKET/helpers/" \
  --region "$REGION" --dest "$SCRATCH"

echo "==> 2/5 rebuild data.json + flags.parquet (with Mongo suppression)"
export DATA_REVIEW_DATA_ROOT="$SCRATCH"
export DATA_REVIEW_DB="${DATA_REVIEW_DB:-data_review}"
export MONGODB_URI="$(aws ssm get-parameter --name "$SSM_MONGO" --with-decryption --region "$REGION" --query Parameter.Value --output text 2>/dev/null || true)"
if [ -z "${MONGODB_URI:-}" ]; then
  echo "    WARNING: could not read $SSM_MONGO -- flags will be built WITHOUT vetting suppression."
  echo "    (approved flags won't be suppressed; everything else still works.)"
fi
python "$DR/flags.py"
python "$DR/build_data.py"

echo "==> 3/5 docker build (bake the new artifacts into the image)"
aws ecr get-login-password --region "$REGION" \
  | docker login --username AWS --password-stdin "$ACCOUNT.dkr.ecr.$REGION.amazonaws.com"
docker build -t "$ECR:latest" "$DR"

echo "==> 4/5 push to ECR"
docker push "$ECR:latest"

echo "==> 5/5 redeploy App Runner"
OP="$(aws apprunner start-deployment --service-arn "$SERVICE_ARN" --region "$REGION" --query OperationId --output text)"
echo ""
echo "Done. Deployment $OP started -- the new data is live in ~3-5 min (rolling deploy)."
echo "Verify:  curl -sI https://kzasevauwn.$REGION.awsapprunner.com/data.json | grep -i content-length"
