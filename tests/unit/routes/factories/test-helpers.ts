/**
 * Test utilities for request handler factory tests
 */

import { z } from 'zod';
import type { RequestHandlerDeps } from '@/routes/factories/types';
import type { DeploymentConfig } from '@/config/deployments';

// Test schema for chat completions
export const testSchema = z.object({
  model: z.string(),
  messages: z.array(
    z.object({
      role: z.string(),
      content: z.string(),
    })
  ),
  stream: z.boolean().optional(),
});

// Mock deployment for tests
export const mockDeployment: DeploymentConfig = {
  name: 'test-deployment',
  modelAlias: 'test-model',
  modelFamily: 'gpt',
  protocolFamily: 'chat-completions',
  azureModelName: 'test-model',
  endpoint: 'https://test.azure.com',
  authConfig: { type: 'api-key', apiKey: 'test', keyHeader: 'api-key' },
  apiVersion: '2024-06-01',
  enabled: true,
};

/**
 * Create mock dependencies for testing the factory
 */
export function createRequestHandlerDeps(): RequestHandlerDeps {
  return {
    schema: testSchema,
    protocol: 'openai',
    path: '/v1/chat/completions',
    proxyStreaming: vi.fn().mockResolvedValue(new Response()),
    proxyNonStreaming: vi.fn().mockResolvedValue(new Response()),
    getModel: (body) => (body as { model: string }).model,
    buildUpstreamUrl: () => 'http://test/upstream',
    transformBody: (body) => body as Record<string, unknown>,
  };
}
