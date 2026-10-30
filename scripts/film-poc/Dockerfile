FROM python:3.13-slim-bookworm
ARG SPEKTRAFILM_COMMIT=3bb2c2d2801ff68b92019cf1dbcbb133d60832bc
ENV OMP_NUM_THREADS=2 OPENBLAS_NUM_THREADS=2 NUMBA_NUM_THREADS=2 MPLBACKEND=Agg QT_QPA_PLATFORM=offscreen
RUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates libgomp1 libgl1 libegl1 libglib2.0-0 \
    && rm -rf /var/lib/apt/lists/*
RUN git init /opt/spektrafilm && cd /opt/spektrafilm \
    && git remote add origin https://github.com/andreavolpato/spektrafilm.git \
    && git fetch --depth 1 origin "$SPEKTRAFILM_COMMIT" && git checkout --detach FETCH_HEAD \
    && test "$(git rev-parse HEAD)" = "$SPEKTRAFILM_COMMIT"
WORKDIR /poc
COPY dependencies.py smoke.py ./
# Audit every upstream direct requirement for a compatible binary wheel first.
# Preserve this report even if the complete dependency installation fails.
CMD ["python", "dependencies.py"]
