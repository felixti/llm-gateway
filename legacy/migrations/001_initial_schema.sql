-- PostgreSQL Schema for LLM Gateway
-- Migration: 001_initial_schema

-- Users table
CREATE TABLE IF NOT EXISTS users (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    email VARCHAR(255) UNIQUE NOT NULL,
    monthly_budget_usd DECIMAL(10, 6) NOT NULL DEFAULT 50.00,
    hard_limit BOOLEAN DEFAULT true,
    rate_limit_tier VARCHAR(20) DEFAULT 'standard',
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- API Keys table (PAT storage)
CREATE TABLE IF NOT EXISTS api_keys (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID REFERENCES users(id) ON DELETE CASCADE,
    key_hash VARCHAR(255) NOT NULL,
    prefix VARCHAR(20) NOT NULL,
    scope VARCHAR(50) DEFAULT 'all',
    jti VARCHAR(255) UNIQUE NOT NULL,
    expires_at TIMESTAMPTZ,
    revoked_at TIMESTAMPTZ,
    revoked_reason TEXT,
    last_used_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Usage history table (monthly aggregated)
CREATE TABLE IF NOT EXISTS usage_history (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID REFERENCES users(id),
    month VARCHAR(7) NOT NULL,
    total_requests INTEGER DEFAULT 0,
    total_tokens_input BIGINT DEFAULT 0,
    total_tokens_output BIGINT DEFAULT 0,
    total_tokens_thinking BIGINT DEFAULT 0,
    total_cost_usd DECIMAL(12, 6) DEFAULT 0,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE(user_id, month)
);

-- Request audit table (individual requests)
CREATE TABLE IF NOT EXISTS request_audit (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID REFERENCES users(id),
    request_id VARCHAR(255) NOT NULL,
    model VARCHAR(100),
    deployment VARCHAR(100),
    protocol_family VARCHAR(30),
    tokens_input INTEGER,
    tokens_output INTEGER,
    tokens_thinking INTEGER,
    cost_usd DECIMAL(10, 6),
    thinking_enabled BOOLEAN DEFAULT false,
    azure_auth_type VARCHAR(20),
    duration_ms INTEGER,
    status_code INTEGER,
    error_message TEXT,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- PAT revocation log
CREATE TABLE IF NOT EXISTS pat_revocation_log (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    pat_id UUID REFERENCES api_keys(id),
    revoked_by UUID REFERENCES users(id),
    revoked_at TIMESTAMPTZ DEFAULT NOW(),
    reason TEXT
);

-- Indexes for common queries
CREATE INDEX IF NOT EXISTS idx_request_audit_user_created ON request_audit(user_id, created_at);
CREATE INDEX IF NOT EXISTS idx_request_audit_model ON request_audit(model, created_at);
CREATE INDEX IF NOT EXISTS idx_api_keys_user ON api_keys(user_id);
CREATE INDEX IF NOT EXISTS idx_api_keys_jti ON api_keys(jti);
CREATE INDEX IF NOT EXISTS idx_usage_history_user_month ON usage_history(user_id, month);
