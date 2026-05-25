# Plain RUN steps (no BuildKit --mount) so `DOCKER_BUILDKIT=0 docker compose build` works if needed.
# Slow builds = npm ↔ registry.npmjs.org from the build container network.
FROM node:20-bookworm-slim

# Bump when gRPC service paths or stub overlay change (docker inspect shows this).
LABEL org.opencontainers.image.description="gsdk-sidecar (gRPC stubs patched for gateway /gsdk.connect.Connect)"

WORKDIR /app

COPY gsdk-sidecar/package.json gsdk-sidecar/package-lock.json ./
RUN npm config set fetch-retries 10 && \
    npm config set fetch-retry-mintimeout 20000 && \
    npm config set fetch-retry-maxtimeout 120000 && \
    npm ci --omit=dev

# One physical @grpc/grpc-js for the whole process (see gsdk-sidecar/server.js assertConnectClientAcceptsGatewayCreds).
ENV NODE_PATH=/app/node_modules

COPY g-sdk-1.9.0.tar.gz /tmp/g-sdk-1.9.0.tar.gz
RUN mkdir -p /opt/gsdk && tar -xzf /tmp/g-sdk-1.9.0.tar.gz -C /opt/gsdk
# Gateway 1.9 registers gRPC paths as /gsdk.connect.Connect/... (not /connect.Connect/...)
COPY gsdk-sidecar/face_grpc_pb.js /opt/gsdk/g-sdk-1.9.0/client/node/biostar/service/face_grpc_pb.js
COPY gsdk-sidecar/user_grpc_pb.js /opt/gsdk/g-sdk-1.9.0/client/node/biostar/service/user_grpc_pb.js
COPY g-sdk-1.9.0/client/node/biostar/service/connect_grpc_pb.js /opt/gsdk/g-sdk-1.9.0/client/node/biostar/service/connect_grpc_pb.js
COPY g-sdk-1.9.0/client/node/biostar/service/event_grpc_pb.js /opt/gsdk/g-sdk-1.9.0/client/node/biostar/service/event_grpc_pb.js
COPY g-sdk-1.9.0/client/node/biostar/service/user_pb.js /opt/gsdk/g-sdk-1.9.0/client/node/biostar/service/user_pb.js
# Generated *_grpc_pb.js uses require("grpc"); native grpc does not compile on Node 20. Patch + minimal deps only.
RUN cd /opt/gsdk/g-sdk-1.9.0/client/node && \
    find biostar/service -name '*_grpc_pb.js' -type f -exec sed -i "s|require('grpc')|require('@grpc/grpc-js')|g" {} + && \
    rm -f package-lock.json && \
    printf '%s\n' '{"name":"expo-fr-gsdk-pb","private":true,"version":"1.0.0","dependencies":{"google-protobuf":"3.21.4"}}' > package.json && \
    npm config set fetch-retries 10 && \
    npm config set fetch-retry-mintimeout 20000 && \
    npm config set fetch-retry-maxtimeout 120000 && \
    npm install --omit=dev --no-audit --no-fund && \
    mkdir -p node_modules/@grpc && \
    rm -rf node_modules/@grpc/grpc-js && \
    ln -sf /app/node_modules/@grpc/grpc-js node_modules/@grpc/grpc-js

COPY gsdk-sidecar/server.js ./server.js

EXPOSE 4500
CMD ["npm", "run", "start"]
