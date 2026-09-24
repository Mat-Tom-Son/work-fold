FROM ubuntu:24.04
ARG NODE_VERSION=24.21.0
ARG RUST_VERSION=1.98.1
ENV DEBIAN_FRONTEND=noninteractive
RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates curl xz-utils build-essential git python3 pkg-config rpm \
    libgtk-3-0t64 libnotify4 libnss3 libxss1 libxtst6 libasound2t64 libgbm1 \
    libsecret-1-0 libatspi2.0-0t64 libdrm2 libx11-xcb1 xdg-utils \
    xvfb xauth dbus-x11 gnome-keyring libglib2.0-bin fonts-dejavu-core \
    libgstreamer1.0-dev libgstreamer-plugins-base1.0-dev \
    gstreamer1.0-pipewire gstreamer1.0-plugins-base \
    libei-dev libeis-dev libxkbcommon-dev libclang-dev \
    && rm -rf /var/lib/apt/lists/*
RUN cd /tmp && curl -fsSLO "https://nodejs.org/dist/v${NODE_VERSION}/node-v${NODE_VERSION}-linux-x64.tar.xz" \
    && curl -fsSLO "https://nodejs.org/dist/v${NODE_VERSION}/SHASUMS256.txt" \
    && awk "/ node-v${NODE_VERSION}-linux-x64.tar.xz\$/" SHASUMS256.txt | sha256sum -c - \
    && tar -xJf "node-v${NODE_VERSION}-linux-x64.tar.xz" --strip-components=1 -C /usr/local \
    && rm node-*.tar.xz SHASUMS256.txt \
    && npm install -g npm@11.16.0
ENV RUSTUP_HOME=/opt/rustup CARGO_HOME=/opt/cargo
ENV PATH="/opt/cargo/bin:${PATH}"
RUN curl -fsSL https://sh.rustup.rs -o /tmp/rustup.sh \
    && sh /tmp/rustup.sh -y --no-modify-path --profile minimal --default-toolchain "${RUST_VERSION}" \
    && rm /tmp/rustup.sh && chmod -R a+rwX /opt/cargo /opt/rustup
WORKDIR /work
RUN npm install -g --ignore-scripts @cyclonedx/cyclonedx-npm@6.0.1 \
    && cargo install cargo-cyclonedx --version 0.5.9 --locked \
    && chmod -R a+rwX /opt/cargo/registry
# Run the container as the checkout owner. Chromium's sandbox stays enabled.
CMD ["bash"]
