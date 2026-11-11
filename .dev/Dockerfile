ARG DEV_NODE_IMAGE
ARG DEV_PYTHON_IMAGE
FROM ${DEV_NODE_IMAGE} AS node
FROM ${DEV_PYTHON_IMAGE}

COPY --from=node /usr/local/bin/node /usr/local/bin/node
COPY --from=node /usr/local/lib/node_modules /usr/local/lib/node_modules
RUN ln -s ../lib/node_modules/npm/bin/npm-cli.js /usr/local/bin/npm \
    && ln -s ../lib/node_modules/npm/bin/npx-cli.js /usr/local/bin/npx

RUN apt-get update && apt-get install -y --no-install-recommends \
    bash ca-certificates curl git ffmpeg libatomic1 libstdc++6 \
    libnss3 libatk-bridge2.0-0 libx11-xcb1 libxcomposite1 libxdamage1 \
    libxrandr2 libgbm1 libasound2 libpangocairo-1.0-0 libcups2 \
    libxkbcommon0 fonts-liberation libatspi2.0-0 \
    && rm -rf /var/lib/apt/lists/*

ARG DEV_UID=1000
ARG DEV_GID=1000
RUN if ! getent group "${DEV_GID}" >/dev/null; then groupadd -g "${DEV_GID}" developer; fi \
    && useradd -m -u "${DEV_UID}" -g "${DEV_GID}" -s /bin/bash developer

ENV PUPPETEER_SKIP_DOWNLOAD=true \
    DOTENV_CONFIG_PATH=/dev/null \
    PLAYWRIGHT_BROWSERS_PATH=/ms-playwright \
    npm_config_cache=/npm-cache \
    PIP_DISABLE_PIP_VERSION_CHECK=1 \
    EXPO_NO_TELEMETRY=1 \
    EXPO_NO_DOTENV=1 \
    PATH=/opt/venv/bin:$PATH

WORKDIR /workspace
USER developer
CMD ["sleep", "infinity"]
