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

The image is **self-contained + baked**: `data.json` + `flags.parquet` are built from S3
and baked in, so the container **serves instantly** (reliable App Runner health check).
Vetting persists to Atlas (`data_review.vettings`) via `MONGODB_URI` (SSM secret) + the
instance role. The entrypoint falls back to S3-fetch+build if no artifacts are baked.

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
- Scale-to-zero: App Runner `pause-service`/`resume-service` + a dashboard Start/Stop control.
  Currently **always-running** (`DATA_REVIEW_IDLE_TIMEOUT=0`).
- Data refresh = rebuild + push the image (data is baked). Later: fetch-prebuilt-from-S3 on start.
- Sleep-countdown banner UX (see the main plan's Deferred section).
