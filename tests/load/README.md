# Load Testing

This directory contains load tests for the LLM Gateway using k6.

## Prerequisites

Install k6:
```bash
# macOS
brew install k6

# Linux
sudo gpg -k
sudo gpg --no-default-keyring --keyring /usr/share/keyrings/k6-archive-keyring.gpg --keyserver hkp://keyserver.ubuntu.com:80 --recv-keys C5AD17C747E3415A3642D57D77C6C491D6AC1D69
echo "deb [signed-by=/usr/share/keyrings/k6-archive-keyring.gpg] https://dl.k6.io/deb stable main" | sudo tee /etc/apt/sources.list.d/k6.list
sudo apt-get update
sudo apt-get install k6
```

## Running Load Tests

1. Start the gateway:
```bash
bun run dev
```

2. Run load tests:
```bash
bun run load:test
```

3. With custom environment variables:
```bash
GATEWAY_URL=http://localhost:3000 AUTH_TOKEN=your_token bun run load:test
```

## Test Configuration

The load test simulates:
- Ramp up to 10 virtual users over 30 seconds
- Maintain 10 virtual users for 1 minute
- Ramp down over 30 seconds

Thresholds:
- 95th percentile response time < 500ms
- Error rate < 10%

## Custom Tests

To run with custom parameters:
```bash
k6 run --vus 20 --duration 5m tests/load/k6.config.ts
```

## Metrics

k6 collects:
- HTTP request duration
- Error rate
- Request rate
- Virtual user count

Results are output to stdout and can be exported to various formats (JSON, CSV, InfluxDB, etc.).
