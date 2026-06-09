import { check, sleep } from 'k6';
import http from 'k6/http';
import { Counter, Rate, Trend } from 'k6/metrics';

const quotaExceeded = new Rate('quota_exceeded');
const serverError = new Rate('server_errors');
const requestDuration = new Trend('request_duration');
const quotaRemaining = new Trend('quota_remaining', true);
const total429 = new Counter('total_429_responses');
const total200 = new Counter('total_200_responses');

export const options = {
  stages: [
    { duration: '10s', target: 10 },
    { duration: '20s', target: 50 },
    { duration: '10s', target: 0 },
  ],
  thresholds: {
    http_req_duration: ['p(95)<5000'],
    http_req_failed: ['rate<0.1'],
    server_errors: ['rate<0.01'],
  },
};

const BASE_URL = __ENV.BASE_URL || 'http://localhost:3000';
const PAT_TOKEN = __ENV.PAT_TOKEN || '';
const MODEL = __ENV.MODEL || 'gpt-4o';

if (!PAT_TOKEN) {
  console.error('PAT_TOKEN environment variable is required');
}

export default function () {
  const payload = JSON.stringify({
    model: MODEL,
    messages: [{ role: 'user', content: 'Hello, world!' }],
    max_tokens: 100,
  });

  const res = http.post(`${BASE_URL}/v1/chat/completions`, payload, {
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${PAT_TOKEN}`,
    },
    timeout: '30s',
  });

  const is429 = res.status === 429;
  const is200 = res.status === 200;
  const is5xx = res.status >= 500;

  quotaExceeded.add(is429);
  serverError.add(is5xx);
  requestDuration.add(res.timings.duration);

  if (is429) {
    total429.add(1);
  }
  if (is200) {
    total200.add(1);
  }

  check(res, {
    'status is 200 or 429': (r) => r.status === 200 || r.status === 429,
    'no 500 errors': (r) => r.status < 500,
    'quota never negative': (r) => {
      if (r.status !== 200) return true;
      try {
        const body = JSON.parse(r.body);
        if (body.quota_remaining !== undefined) {
          const remaining = Number(body.quota_remaining);
          quotaRemaining.add(remaining);
          return remaining >= 0;
        }
        return true;
      } catch {
        return true;
      }
    },
    '429 has error body': (r) => {
      if (r.status !== 429) return true;
      try {
        const body = JSON.parse(r.body);
        return typeof body.error === 'object' || typeof body.message === 'string';
      } catch {
        return false;
      }
    },
  });

  sleep(0.1);
}

export function handleSummary(data) {
  const totalReqs = data.metrics.iterations?.values?.count || 0;
  const httpReqs = data.metrics.http_reqs?.values?.count || 0;
  const p95 = data.metrics.http_req_duration?.values?.['p(95)'] || 0;

  console.log('\n--- Quota Pressure Test Summary ---');
  console.log(`Total iterations: ${totalReqs}`);
  console.log(`Total HTTP requests: ${httpReqs}`);
  console.log(`P95 latency: ${p95.toFixed(2)}ms`);

  if (data.metrics.total_429_responses) {
    console.log(`429 (quota exceeded): ${data.metrics.total_429_responses.values.count}`);
  }
  if (data.metrics.total_200_responses) {
    console.log(`200 (success): ${data.metrics.total_200_responses.values.count}`);
  }

  return {
    stdout: '',
  };
}
