FROM node:latest

WORKDIR /usr/src/app

COPY app/package.json ./package.json
RUN apt-get update && apt-get install -y lm-sensors && rm -rf /var/lib/apt/lists/*
RUN npm install --omit=dev

COPY app ./app

CMD ["node", "app/index.js"]
