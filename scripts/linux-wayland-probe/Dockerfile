# Contributor-only feasibility tooling; these dependencies are not shipped yet.
FROM work-fold-linux-build
USER root
RUN apt-get update && apt-get install -y --no-install-recommends \
    libgstreamer1.0-dev libgstreamer-plugins-base1.0-dev \
    gstreamer1.0-pipewire gstreamer1.0-plugins-base \
    libei-dev libeis-dev libxkbcommon-dev libclang-dev \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /work
