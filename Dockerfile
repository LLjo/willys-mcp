FROM node:22-bookworm-slim

ENV DEBIAN_FRONTEND=noninteractive \
    PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true \
    PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium \
    NODE_ENV=production \
    PORT=8096

RUN apt-get update && apt-get install -y --no-install-recommends \
      python3 python3-pip python3-venv pipx \
      chromium chromium-sandbox \
      ca-certificates \
      fonts-liberation \
      libnss3 libatk1.0-0 libatk-bridge2.0-0 libcups2 libdrm2 libxkbcommon0 \
      libxcomposite1 libxdamage1 libxfixes3 libxrandr2 libgbm1 libpango-1.0-0 \
      libasound2 libxshmfence1 \
      build-essential python3-dev \
    && rm -rf /var/lib/apt/lists/*

RUN pipx install mcp-proxy && pipx ensurepath
ENV PATH="/root/.local/bin:${PATH}"

WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm ci || npm install

COPY . .

EXPOSE 8096

CMD ["mcp-proxy", "--port=8096", "--host=0.0.0.0", "--pass-environment", "--", "npx", "tsx", "mcp-server.ts"]
