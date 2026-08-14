FROM node:22-bookworm

ARG UV_VERSION=0.11.26

RUN sed -i \
    's|http://deb.debian.org/debian|https://mirrors.aliyun.com/debian|g' \
    /etc/apt/sources.list.d/debian.sources \
  && apt-get -o Acquire::Retries=5 update \
  && DEBIAN_FRONTEND=noninteractive apt-get -o Acquire::Retries=5 install -y --no-install-recommends \
    ca-certificates \
    curl \
    dpkg-dev \
    fakeroot \
    file \
    rpm \
    xz-utils \
  && rm -rf /var/lib/apt/lists/* \
  && curl -LsSf "https://astral.sh/uv/${UV_VERSION}/install.sh" \
    | env UV_INSTALL_DIR=/usr/local/bin sh

WORKDIR /work
