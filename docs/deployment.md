# Deployment Guide

## Prerequisites

- Bun 1.2+
- Docker (optional)
- Redis 7+
- PostgreSQL 16+
- Azure OpenAI or Azure AI Foundry access

## Quick Start

```bash
# 1. Install dependencies
bun install

# 2. Copy environment variables
cp .env.example .env
# Edit .env with your credentials

# 3. Run database migrations
bun run db:migrate

# 4. Start the server
bun run start
```

## Docker

```bash
# Build image
docker build -t llm-gateway .

# Run with compose (includes Redis + Postgres)
docker-compose up
```

## Environment Variables

See `.env.example` for all required and optional variables.

## Health Checks

- `GET /health/live` — Liveness probe
- `GET /health/ready` — Readiness probe (checks Redis, Postgres, deployments)

## Scaling

The gateway is stateless. Scale horizontally by running multiple instances behind a load balancer. All state is in Redis and PostgreSQL.
