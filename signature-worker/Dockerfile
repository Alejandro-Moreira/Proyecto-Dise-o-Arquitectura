FROM node:20-alpine

RUN apk add --no-cache wget

WORKDIR /app

COPY package.json ./
RUN npm install --omit=dev

COPY index.js metrics.js ./

USER node

# Puerto mínimo solo para healthcheck
EXPOSE 3003

CMD ["node", "index.js"]
