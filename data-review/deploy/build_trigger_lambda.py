"""
S3-upload -> CodeBuild trigger for the data-review prebuilt-artifacts pipeline.

The error-review bucket is in ap-southeast-2, so this Lambda runs there (S3
bucket notifications require a same-region target). CodeBuild lives in
ap-southeast-1, so the boto3 client targets BUILD_REGION explicitly.

Debounce: an upload writes ~80 objects, each firing this Lambda. We coalesce
them into a single build -- skip if a build is already IN_PROGRESS or one
started within DEBOUNCE_SECONDS. CodeBuild also takes ~1 min to provision
before it fetches inputs, which naturally lets a fast multi-object upload
settle. The S3 notification is prefix-filtered to final/ + helpers/ (never
built/), so the build's own output can't retrigger it.
"""
import os
import time
import boto3

PROJECT = os.environ.get("CODEBUILD_PROJECT", "data-review-build")
BUILD_REGION = os.environ.get("BUILD_REGION", "ap-southeast-1")
DEBOUNCE_SECONDS = int(os.environ.get("DEBOUNCE_SECONDS", "180"))

cb = boto3.client("codebuild", region_name=BUILD_REGION)


def handler(event, context):
    ids = cb.list_builds_for_project(projectName=PROJECT, sortOrder="DESCENDING").get("ids", [])[:5]
    if ids:
        now = time.time()
        for b in cb.batch_get_builds(ids=ids).get("builds", []):
            if b.get("buildStatus") == "IN_PROGRESS":
                print("build already in progress -> skip")
                return {"skipped": "in_progress"}
            st = b.get("startTime")
            if st and (now - st.timestamp()) < DEBOUNCE_SECONDS:
                print(f"a build started {now - st.timestamp():.0f}s ago (< {DEBOUNCE_SECONDS}s) -> skip")
                return {"skipped": "debounce"}
    bid = cb.start_build(projectName=PROJECT)["build"]["id"]
    print(f"started build {bid}")
    return {"started": bid}
