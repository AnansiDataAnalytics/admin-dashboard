# Self-contained build+serve container for the data-review app.
# On start it syncs inputs from S3 (fetch_inputs.py), builds data.json +
# flags.parquet (flags.py, build_data.py), then serves (serve.py).
# v1 trade-off: ~minutes cold start; optimise later to fetch prebuilt outputs.
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
    DATA_REVIEW_SCRATCH=/scratch

EXPOSE 8080
RUN chmod +x /app/entrypoint.sh
ENTRYPOINT ["/app/entrypoint.sh"]
