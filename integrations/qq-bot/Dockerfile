FROM mcr.microsoft.com/playwright:v1.56.1-noble
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY *.mjs ./
ENV QQ_BOT_STATE_DIR=/state
CMD ["node", "bot.mjs"]
