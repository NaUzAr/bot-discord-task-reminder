FROM node:24-alpine AS builder

# Install OpenSSL & libc6-compat for Prisma engine compatibility on Alpine
RUN apk add --no-cache openssl libc6-compat

WORKDIR /app

# Install dependencies
COPY package.json package-lock.json* ./
RUN npm install

# Copy Prisma schema and generate client
COPY prisma ./prisma
RUN npx prisma generate

# Copy source code and build
COPY . .
RUN npm run build

# Production image
FROM node:24-alpine AS runner

# Install OpenSSL & libc6-compat for Prisma engine compatibility on Alpine
RUN apk add --no-cache openssl libc6-compat

WORKDIR /app

# Only install production dependencies
COPY package.json package-lock.json* ./
RUN npm install --omit=dev

# Copy generated Prisma client
COPY --from=builder /app/node_modules/.prisma ./node_modules/.prisma
COPY --from=builder /app/node_modules/@prisma ./node_modules/@prisma

# Copy built dist folder, prisma schema, & static web public assets
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/prisma ./prisma
COPY --from=builder /app/scripts ./scripts
COPY --from=builder /app/src/web/public ./src/web/public

# Command to run (syncs database schema and starts application)
CMD ["npm", "run", "start:prod"]
