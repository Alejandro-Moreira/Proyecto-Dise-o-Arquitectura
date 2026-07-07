FROM node:20-alpine

# Instalar wget para los healthchecks del compose
RUN apk add --no-cache wget

WORKDIR /app

# Copiar manifesto e instalar dependencias primero (capa cacheada)
COPY package.json ./
RUN npm install --omit=dev

# Copiar código fuente
COPY index.js metrics.js ./

# Usuario no-root por seguridad
USER node

EXPOSE 8080

CMD ["node", "index.js"]
