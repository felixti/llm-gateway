/**
 * Models Routes - /v1/models
 * Returns protocol family metadata and scope filtering
 * Lists all available models with their deployment info
 */

import { Hono } from 'hono';
import { type DeploymentConfig, getAllDeployments } from '../config/deployments';
import { authMiddleware } from '../middleware/auth';
import { scopeMiddleware } from '../middleware/scope';

// Create models routes
export const modelsRoutes = new Hono();

// Apply auth middleware
modelsRoutes.use('*', authMiddleware);
modelsRoutes.use('*', scopeMiddleware);

// GET /v1/models
modelsRoutes.get('/', (c) => {
  const scope = c.get('scope') || 'all';

  // Get all enabled deployments
  let deployments = getAllDeployments();

  // Filter by scope if not admin
  if (scope !== 'all' && scope !== 'models') {
    // User scope filtering - in production, this would check user permissions
    deployments = deployments.filter((d) => d.name.includes(scope));
  }

  // Build response in OpenAI format
  const response = {
    object: 'list',
    data: deployments.map(deploymentToModel),
  };

  return c.json(response);
});

/**
 * Convert deployment to OpenAI model format
 */
function deploymentToModel(deployment: DeploymentConfig): Record<string, unknown> {
  return {
    id: deployment.modelAlias,
    object: 'model',
    created: 1700000000, // Approximate creation time
    owned_by: deployment.modelFamily,
    permission: [],
    root: deployment.modelAlias,
    parent: null,
    // Custom fields for gateway
    gateway: {
      deployment_name: deployment.name,
      model_family: deployment.modelFamily,
      protocol_family: deployment.protocolFamily,
      azure_model_name: deployment.azureModelName,
      endpoint: deployment.endpoint.replace(/https?:\/\//, ''), // Strip protocol for display
      fallback: deployment.fallbackDeployment || null,
    },
  };
}
