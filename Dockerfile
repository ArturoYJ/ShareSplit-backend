FROM node:20-alpine

WORKDIR /app

# Instalar dependencias primero (cache layer)
COPY package*.json ./
RUN npm ci --omit=dev

# Copiar código fuente
COPY src/ ./src/

EXPOSE 3001

CMD ["node", "src/index.js"]
