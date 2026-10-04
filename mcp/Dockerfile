FROM node:24-alpine
WORKDIR /app
COPY package.json pnpm-lock.yaml ./
RUN npm install --global pnpm@11.25.0 && pnpm install --frozen-lockfile --prod
COPY src ./src
USER node
EXPOSE 3000
CMD ["node", "src/index.js"]
