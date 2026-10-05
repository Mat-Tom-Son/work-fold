# Standard repository formats and signatures; private production keys are never
# baked into this image. Acceptance uses an ephemeral container-owned test key.
FROM work-fold-linux-build
USER root
RUN apt-get update && apt-get install -y --no-install-recommends \
    aptly createrepo-c gnupg \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /work
