# Imagen base ligera de Node.js
FROM node:24-alpine

# Carpeta de trabajo dentro del contenedor
WORKDIR /app

# Copiamos primero package.json (y package-lock.json si existe)
# para aprovechar la cache de Docker: si no cambian las dependencias,
# no se vuelven a instalar en cada build
COPY package*.json ./

# Instala solo dependencias de producción
RUN npm ci --omit=dev

# Copia el resto del código fuente
COPY --chown=node:node . .

USER node

# Puerto en el que escucha la app (debe coincidir con la variable PORT)
EXPOSE 3000

# Comando de arranque
CMD ["npm", "start"]
