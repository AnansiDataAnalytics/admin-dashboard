# Serve container for the data-review app. On start it pulls PREBUILT artifacts
# (data.json + flags.parquet) from S3 -- built off-box by CodeBuild on each data
# upload -- falling back to baked artifacts, then a full in-container build
# (see entrypoint.sh). Then serves via serve.py. Vetting persists to Atlas
# (MONGODB_URI); the container filesystem stays ephemeral.
FROM python:3.12-slim

WORKDIR /app

# Build deps (pandas/numpy/pyarrow for the .dta -> data.json/flags.parquet build)
# + awscli for the S3 sync in fetch_inputs.py.
RUN pip install --no-cache-dir pandas numpy pyarrow awscli pymongo dnspython

COPY . /app/

# DATA_REVIEW_S3_CHAINLINKED / _GMD / _HELPERS + AWS_REGION are supplied at run
# time (task definition). EMBED + bind + idle are baked to safe container defaults.
ENV DATA_REVIEW_BIND=0.0.0.0 \
    PORT=8080 \
    DATA_REVIEW_IDLE_TIMEOUT=0 \
    DATA_REVIEW_EMBED=1 \
    DATA_REVIEW_SCRATCH=/scratch \
    DATA_REVIEW_S3_BUILT=s3://error-review/built

EXPOSE 8080
RUN chmod +x /app/entrypoint.sh
ENTRYPOINT ["/app/entrypoint.sh"]
