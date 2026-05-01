import { check, sleep } from 'k6';
import http from 'k6/http';
import { Rate, Trend } from 'k6/metrics';

const errorRate = new Rate('errors');
const latency = new Trend('latency');

export const options = {
  stages: [
    { duration: '30s', target: 10 },
    { duration: '1m', target: 10 },
    { duration: '30s', target: 0 },
  ],
  thresholds: {
    http_req_duration: ['p(95)<500'],
    errors: ['rate<0.1'],
  },
};

const GATEWAY_URL = __ENV.GATEWAY_URL || 'http://localhost:3000';
const AUTH_TOKEN = __ENV.AUTH_TOKEN || '';

export default function () {
  const headers = {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${AUTH_TOKEN}`,
  };

  const payload = JSON.stringify({
    model: 'gpt-4.1-mini',
    messages: [{ role: 'user', content: 'Hello' }],
    max_tokens: 10,
  });

  const res = http.post(`${GATEWAY_URL}/v1/chat/completions`, payload, { headers });

  check(res, {
    'status is 200 or 429': (r) => r.status === 200 || r.status === 429,
    'response time < 500ms': (r) => r.timings.duration < 500,
  });

  errorRate.add(res.status !== 200 && res.status !== 429);
  latency.add(res.timings.duration);

  sleep(1);
}
