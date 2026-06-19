# Semantic cache: in-process BGE embedder + PostgreSQL pgvector backend

**Status:** accepted — **deferred for the MVP.** ADR-0011 removes PostgreSQL/pgvector from the MVP store stack, and semantic cache is out of MVP scope. This decision (local BGE embedder + pgvector) still stands for when a vector store and the semantic-cache feature return post-MVP; it does not apply to the MVP build.

The semantic-cache tier uses a **local in-process embedder** (BGE-small-en, ~384d) loaded via `@xenova/transformers` (ONNX), **lazy-loaded on first request** (`/ready` false until loaded), and stores embeddings + responses in **PostgreSQL with the `pgvector` extension** on a managed PG18 instance. Exact-match tier (sha256 key) lives in the same table, gated by a partial index. No Redis Stack, no Qdrant.

> **Performance numbers below are targets, not measured.** `@xenova/transformers` is not yet a dependency and Bun+ONNX is unproven — a Phase 3 spike validates load/inference/cold-start/RSS under Bun before commit (plan §10 Phase 3 + risks). If the spike fails the targets, the embedder choice is revisited.

## Why

- **Managed Redis constraint.** Our Redis is Azure Cache for Redis (standard tier) — no module loading, no Redis Stack, no `FT.SEARCH`. Vector ops must live elsewhere.
- **Postgres is already in the stack.** Reusing it for vector storage avoids a new service (Qdrant) with its own ops surface, backup story, and failure mode. PG18 + pgvector HNSW indexes (`m=16, ef_construction=64`) deliver ~5–20ms cosine queries at our expected cardinality (<1M cached responses per month).
- **Local embedder kills the chicken-and-egg.** Calling our own gateway for an embedding on every cache lookup creates recursive quota/rate-limit/circuit-breaker cycles. In-process BGE = **target ~5–15ms p50 (unvalidated, gated by spike)**, zero per-embed cost, no upstream dependency.
- **384-dim vectors** are ¼ the storage of OpenAI 1536-dim embeddings; competitive recall on MTEB.

## Considered alternatives

- **C-A: Azure `text-embedding-3-small` + Redis Stack** — rejected: managed Redis can't run modules; embedder over network adds 30–80ms per lookup; recursive quota cycle.
- **C-C: Azure embedder + Qdrant** — rejected: extra container/service for a feature Postgres can serve; new failure mode; backup duplication.
- **Embedder via own gateway** — rejected: recursive quota/circuit-breaker; gateway downtime kills cache.

## Consequences

- **Hard dep: PostgreSQL ≥ 16** (pgvector 0.7+). Target PG18 in `docker-compose.yml` and managed env. Migration creates `CREATE EXTENSION IF NOT EXISTS vector`.
- **Image size +200MB** for ONNX runtime + BGE weights. Mitigation: lazy-load on first request; `/ready` returns false until model loaded; document cold-start (~3s).
- **+~50MB RAM per instance** for the loaded model. Negligible at gateway scale.
- **`semantic_cache` table** holds both tiers: exact (partial index on `key_hash WHERE ttl_at > now()`) and semantic (HNSW on `embedding`). Single retention sweep handles both.
- **Multilingual / longer context** is a one-file swap to BGE-M3 (1024d). Embedder abstraction in `modules/cache/embed.ts`.
- **Cache writes bypass the WAL DLQ** (cache loss on PG outage is acceptable; spend/audit is not).
