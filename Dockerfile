FROM node:24-alpine AS builder

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

WORKDIR /app

# Only install production dependencies
COPY package.json package-lock.json* ./
RUN npm install --omit=dev

# Copy generated Prisma client
COPY --from=builder /app/node_modules/.prisma ./node_modules/.prisma
COPY --from=builder /app/node_modules/@prisma ./node_modules/@prisma

# Copy built dist folder
COPY --from=builder /app/dist ./dist

# Command to run
CMD ["npm", "run", "start"]
