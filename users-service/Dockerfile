FROM node:20-alpine

RUN apk add --no-cache wget

WORKDIR /app

COPY package.json ./
RUN npm install --omit=dev

COPY index.js ./

USER node

EXPOSE 3001

CMD ["node", "index.js"]
