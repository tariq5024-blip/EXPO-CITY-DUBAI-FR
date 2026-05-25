FROM node:18-bullseye-slim

WORKDIR /app

COPY backend/package.json backend/package-lock.json* ./
RUN npm install

COPY g-sdk-1.9.0.tar.gz /tmp/g-sdk-1.9.0.tar.gz
RUN mkdir -p /tmp/gsdk && tar -xzf /tmp/g-sdk-1.9.0.tar.gz -C /tmp/gsdk
COPY g-sdk-1.9.0/client/node/biostar/service/connect_grpc_pb.js /tmp/gsdk/g-sdk-1.9.0/client/node/biostar/service/connect_grpc_pb.js
COPY g-sdk-1.9.0/client/node/biostar/service/event_grpc_pb.js /tmp/gsdk/g-sdk-1.9.0/client/node/biostar/service/event_grpc_pb.js
RUN npm install /tmp/gsdk/g-sdk-1.9.0/client/node

COPY backend/src ./src

EXPOSE 4000
CMD ["npm", "run", "start"]
