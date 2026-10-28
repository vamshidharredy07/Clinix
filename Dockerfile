FROM node:18-alpine

WORKDIR /usr/src/app

COPY --chown=node:node package*.json ./

RUN npm ci --only=production

COPY --chown=node:node . .

USER node

EXPOSE 5000

CMD ["node", "server.js"]