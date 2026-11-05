# ==============================================================================
# Dockerfile for Hermetic Agent Sandbox (bantha:latest)
# Builds all 4 agents (pi, goose, crush, hermes) into an isolated Ubuntu container
# ==============================================================================

FROM ubuntu:24.04

ENV DEBIAN_FRONTEND=noninteractive
ENV SHELL=/bin/bash

# 1. Install system utilities, networking tools, and build dependencies
RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates \
    curl \
    git \
    gnupg \
    build-essential \
    python3 \
    python3-pip \
    python3-venv \
    python3-setuptools \
    iptables \
    iproute2 \
    dnsutils \
    netcat-openbsd \
    gosu \
    jq \
    && rm -rf /var/lib/apt/lists/*

# 2. Install Node.js LTS (v24) & npm
RUN curl -fsSL https://deb.nodesource.com/setup_24.x | bash - \
    && apt-get install -y --no-install-recommends nodejs \
    && rm -rf /var/lib/apt/lists/*

# 3. Install Agent: Pi (via npm globally)
RUN npm install -g @earendil-works/pi-coding-agent

# 4. Copy pre-built standalone binaries for goose and crush
COPY ./bin-cache/goose /usr/local/bin/goose
COPY ./bin-cache/crush /usr/local/bin/crush

# 5. Setup hermes agent environment with its own bundled python runtime
RUN mkdir -p /opt/hermes/hermes-agent /opt/hermes/tools
COPY ./hermes-portable/hermes-agent /opt/hermes/hermes-agent
COPY ./hermes-portable/tools /opt/hermes/tools

# Create clean /usr/local/bin/hermes wrapper pointing to hermes bundled runtime
RUN echo '#!/bin/sh\nexport HERMES_HOME=/home/sandbox/.hermes\nexec /opt/hermes/tools/python-3.14.9+20261021-linux-x64/bin/python3 -I -c '\''import os, sys\nos.environ.pop("PYTHONHOME", None)\nos.environ.pop("PYTHONPATH", None)\nsys.path.insert(0, "/opt/hermes/hermes-agent")\nfrom hermes_cli.main import main\nsys.exit(main())'\'' "$@"' > /usr/local/bin/hermes && \
    chmod +x /usr/local/bin/hermes

RUN chmod +x /usr/local/bin/* 2>/dev/null || true

# 6. Setup entrypoint and DNS filter gate
RUN mkdir -p /opt/sandbox /home/sandbox
COPY entrypoint.sh /opt/sandbox/entrypoint.sh
COPY dns-gate.py /opt/sandbox/dns-gate.py
RUN chmod +x /opt/sandbox/entrypoint.sh /opt/sandbox/dns-gate.py

ENV HOME=/home/sandbox
WORKDIR /home/sandbox

ENTRYPOINT ["/opt/sandbox/entrypoint.sh"]
CMD ["/bin/bash"]
