FROM node:alpine

WORKDIR /usr/src/app
COPY app/package.json ./
COPY app ./app
# Install lm-sensors using apk (Alpine package manager)
RUN apk add --no-cache lm_sensors \
  && npm install --omit=dev \
  && npm cache clean --force

CMD ["node", "app/index.js"]
