# Data Review — App Runner deployment

Live resources (region `ap-southeast-1`, account `566474062827`):

| Thing | Value |
|---|---|
| ECR image | `566474062827.dkr.ecr.ap-southeast-1.amazonaws.com/data-review:latest` |
| App Runner service | `arn:aws:apprunner:ap-southeast-1:566474062827:service/data-review/c82e017fb3434a48bcc8b3a56eaab9ed` |
| Service URL | `https://kzasevauwn.ap-southeast-1.awsapprunner.com` |
| IAM access role (ECR pull) | `data-review-apprunner-access` |
| IAM instance role (S3 + SSM/KMS) | `data-review-apprunner-instance` |
| Mongo URI (SecureString) | SSM `/mongodb/data-review/uri` = cluster base URI + `/data_review` |
| **Bake data source** | `s3://error-review/` — `final/` (77 chainlinked + `GMD.dta`) + `helpers/variables.csv`. **No `country_gdp_shares.csv`** there, so the world-GDP `share` check is skipped. Includes the `rHPI` variable. (Switch sources by re-running the build below against another bucket.) |

The container **fetches prebuilt artifacts** (`data.json` + `flags.parquet`) from
`s3://error-review/built/` at start (built off-box by CodeBuild — see the pipeline below),
falling back to artifacts baked into the image, then a full in-container build. The
**↻ Refresh data** button just re-pulls `built/` (~seconds). Vetting persists to Atlas
(`data_review.vettings`) via `MONGODB_URI` (SSM secret) + the instance role.

## Prebuilt-artifacts data pipeline (auto-rebuild on upload)
Data refreshes run OFF the serving box; the container only downloads the result.

**Flow:** upload to `s3://error-review/` (`final/` or `helpers/`) → S3 notification → Lambda
`data-review-build-trigger` (ap-southeast-2, debounced) → CodeBuild `data-review-build`
(ap-southeast-1) → writes `error-review/built/{data.json,flags.parquet}` → the App Runner
container fetches `built/` (at start + via the Refresh button).

| Resource | Where | Definition |
|---|---|---|
| CodeBuild `data-review-build` | ap-southeast-1 | `deploy/codebuild-project.json` — uses the ECR image as the build env + inline buildspec; reads `MONGODB_URI` from SSM for suppression; role `data-review-build-role` |
| Trigger Lambda `data-review-build-trigger` | **ap-southeast-2** (bucket's region) | `deploy/build_trigger_lambda.py` — role `data-review-trigger-role`; env `CODEBUILD_PROJECT`, `BUILD_REGION=ap-southeast-1`, `DEBOUNCE_SECONDS=180` |
| S3 notification | `error-review` (ap-southeast-2) | `deploy/s3-notification.json` — `ObjectCreated` on `final/`+`helpers/` only (never `built/`, so no loop) |
| Artifacts | `s3://error-review/built/` | `data.json` + `flags.parquet` |

**Debounce:** the ~80-object upload burst is coalesced — the Lambda skips if a build is
IN_PROGRESS or started < `DEBOUNCE_SECONDS` ago (and CodeBuild's ~1-min provisioning lets a
fast burst settle before it fetches). **Regions:** `error-review` is in **ap-southeast-2**;
everything else is ap-southeast-1 (build + Lambda reach it cross-region). Manual build:
`aws codebuild start-build --project-name data-review-build --region ap-southeast-1`.

## Build + deploy
```bash
# 1. Build the baked artifacts (from a checkout/scratch with data/final+distribute+helpers):
#    DATA_REVIEW_DATA_ROOT=<root> python flags.py && python build_data.py   # -> data.json, flags.parquet in data-review/
# 2. Build + push the image:
aws ecr get-login-password --region ap-southeast-1 | docker login --username AWS --password-stdin 566474062827.dkr.ecr.ap-southeast-1.amazonaws.com
docker build -t 566474062827.dkr.ecr.ap-southeast-1.amazonaws.com/data-review:latest .   # context = data-review/
docker push 566474062827.dkr.ecr.ap-southeast-1.amazonaws.com/data-review:latest
# 3. First time: create the service (IAM roles + SSM param must exist — see below):
aws apprunner create-service --cli-input-json file://deploy/apprunner-service.json --region ap-southeast-1
#    Subsequent image refreshes: aws apprunner update-service --service-arn <arn> --source-configuration ...
```

## Refreshing data
Normally automatic (see the pipeline above): upload to `error-review` → CodeBuild rebuilds
`built/` → click **↻ Refresh data** in the dashboard (or restart the container) to pull it.
`deploy/refresh.sh` remains as a manual full bake + redeploy (builds locally, bakes the
artifacts into a fresh image) if you ever need to bypass the pipeline.

IAM roles (one-time): `data-review-apprunner-access` trusts `build.apprunner.amazonaws.com`
(+ `AWSAppRunnerServicePolicyForECRAccess`); `data-review-apprunner-instance` trusts
`tasks.apprunner.amazonaws.com` with S3 read on `data-review-app-test` + `ssm:GetParameter`
on the Mongo param + `kms:Decrypt` via `ssm`.

## Dashboard wiring
Point the Next rewrite at the service: set **`DATA_REVIEW_TARGET=https://kzasevauwn.ap-southeast-1.awsapprunner.com`**
(locally to test, and on the Render frontend for the deployed dashboard). No code change.

## ⚠️ Before real / unmasked WED data
- **The App Runner URL is PUBLIC** — it bypasses the dashboard auth. Lock it down (App Runner
  VPC ingress / private, WAF allowlist, or a shared-secret header injected by the dashboard).
- **Base-image CVEs**: the `python:3.12-slim` base flagged 1 critical / 2 high — pin a patched
  base + scan in CI before production.

## Deferred (not built)
- Scale-to-zero: App Runner `pause-service`/`resume-service` + a dashboard Start/Stop
  control. Currently **always-running** (`DATA_REVIEW_IDLE_TIMEOUT=0`).
- A/Q/M (WED) frequencies; sleep-countdown banner UX (see the main plan's Deferred section).

## Runtime S3 access (applied)
The container downloads `built/` from S3, so the App Runner **instance role**
(`data-review-apprunner-instance`) allows `s3:GetObject`/`s3:ListBucket` on `error-review`
(+ legacy `data-review-app-test`). CodeBuild uses `data-review-build-role` (ECR pull +
error-review read/write + the Mongo SSM param + KMS).
