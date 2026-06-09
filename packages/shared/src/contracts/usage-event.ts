export type RedisCommitResult = 'ok' | 'failed';
export type UsageEventStatus = 'completed' | 'failed';

export interface UsageEvent {
  request_id: string;
  event_id: string;
  attempt: number;
  ts: string;
  principal_id: string;
  principal_kind: 'user' | 'sp';
  project_id?: string;
  model: string;
  deployment: string;
  provider: string;
  tokens_prompt: number;
  tokens_completion: number;
  tokens_total: number;
  cost_usd: string;
  status: UsageEventStatus;
  latency_ms: number;
  redis_commit_result: RedisCommitResult;
  reservation_id: string;
  scope: string;
}
