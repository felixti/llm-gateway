import type { DeploymentConfig } from '@/config/deployments';

const MODEL_SCOPE_PREFIX = 'models:';

export function isModelScope(scope: unknown): scope is string {
  return typeof scope === 'string' && scope.toLowerCase().startsWith(MODEL_SCOPE_PREFIX);
}

function getScopedModel(scope: string): string {
  return scope.slice(MODEL_SCOPE_PREFIX.length).toLowerCase();
}

export function canAccessModel(scope: unknown, model: string): boolean {
  if (scope === 'all' || scope === 'admin' || scope === 'read') {
    return true;
  }

  if (!isModelScope(scope)) {
    return false;
  }

  return getScopedModel(scope) === model.toLowerCase();
}

export function canAccessDeployment(scope: unknown, deployment: DeploymentConfig): boolean {
  if (canAccessModel(scope, deployment.modelAlias)) {
    return true;
  }

  if (!isModelScope(scope)) {
    return false;
  }

  const scopedModel = getScopedModel(scope);
  return (
    scopedModel === deployment.name.toLowerCase() ||
    scopedModel === deployment.azureModelName.toLowerCase()
  );
}

export function filterDeploymentsForScope(
  deployments: DeploymentConfig[],
  scope: unknown
): DeploymentConfig[] {
  if (scope === 'all' || scope === 'admin' || scope === 'read' || !scope) {
    return deployments;
  }

  if (!isModelScope(scope)) {
    return [];
  }

  return deployments.filter((deployment) => canAccessDeployment(scope, deployment));
}
