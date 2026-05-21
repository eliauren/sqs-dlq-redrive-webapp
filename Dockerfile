FROM node:25-alpine AS build

WORKDIR /app

COPY package.json package-lock.json tsconfig.json .npmrc ./
COPY src ./src
COPY public ./public

RUN npm ci && npm run build

FROM node:25-alpine AS runtime

WORKDIR /app

ENV NODE_ENV=production
ENV PORT=3000

COPY package.json package-lock.json .npmrc ./
RUN npm ci --omit=dev

COPY --from=build /app/dist ./dist
COPY public ./public

EXPOSE 3000

CMD ["node", "dist/server.js"]

