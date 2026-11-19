# syntax=docker/dockerfile:1
# The aifactory-review engine image: Node, the engine, the policy, the rule pack and three scanners.
# Every version and checksum comes from pins.json through scripts/build-image.mjs; nothing floats.
ARG PIN_BASE_IMAGE
FROM ${PIN_BASE_IMAGE}

RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates curl git \
 && rm -rf /var/lib/apt/lists/*

ARG PIN_GITLEAKS_VERSION
ARG PIN_GITLEAKS_SHA256
RUN curl -fsSLo /tmp/t.tgz "https://github.com/gitleaks/gitleaks/releases/download/v${PIN_GITLEAKS_VERSION}/gitleaks_${PIN_GITLEAKS_VERSION}_linux_x64.tar.gz" \
 && echo "${PIN_GITLEAKS_SHA256}  /tmp/t.tgz" | sha256sum -c - \
 && tar -xzf /tmp/t.tgz -C /usr/local/bin gitleaks && rm /tmp/t.tgz

ARG PIN_OPENGREP_VERSION
ARG PIN_OPENGREP_ASSET
ARG PIN_OPENGREP_SHA256
RUN curl -fsSLo /usr/local/bin/opengrep "https://github.com/opengrep/opengrep/releases/download/v${PIN_OPENGREP_VERSION}/${PIN_OPENGREP_ASSET}" \
 && echo "${PIN_OPENGREP_SHA256}  /usr/local/bin/opengrep" | sha256sum -c - \
 && chmod 0755 /usr/local/bin/opengrep

ARG PIN_OSV_SCANNER_VERSION
ARG PIN_OSV_SCANNER_SHA256
RUN curl -fsSLo /usr/local/bin/osv-scanner "https://github.com/google/osv-scanner/releases/download/v${PIN_OSV_SCANNER_VERSION}/osv-scanner_linux_amd64" \
 && echo "${PIN_OSV_SCANNER_SHA256}  /usr/local/bin/osv-scanner" | sha256sum -c - \
 && chmod 0755 /usr/local/bin/osv-scanner

# The engine. Root-owned and read-only; it runs as the unprivileged "node" user from the base image.
COPY package.json pins.json /opt/aifactory/
COPY engine/ /opt/aifactory/engine/
COPY policy/ /opt/aifactory/policy/
COPY rules/ /opt/aifactory/rules/
RUN chmod -R a+rX,go-w /opt/aifactory

ENV AIFACTORY_RULES_DIR=/opt/aifactory/rules/opengrep
USER node
WORKDIR /tmp
ENTRYPOINT ["node", "/opt/aifactory/engine/bin/aifactory-review.mjs"]
