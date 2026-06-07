FROM quay.io/prometheus/node-exporter:latest AS exporter

FROM node:current-alpine

ARG SW_VERSION=2.0.0
ENV SW_VERSION=${SW_VERSION}

COPY --from=exporter /bin/node_exporter /usr/local/bin/node_exporter

RUN apk add --no-cache coreutils findutils

WORKDIR /usr/src/app

COPY package.json ./
RUN npm install --omit=dev

COPY index.js ./index.js
COPY collector.sh /collector.sh
RUN chmod +x /collector.sh

CMD ["node", "index.js"]
