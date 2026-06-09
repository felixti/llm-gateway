// Config module exports
export { env } from './env';
export type { Env } from './env';

export {
  DEPLOYMENTS,
  getDeploymentByAlias,
  getModelFamily,
  getProtocolFamily,
  getDeploymentsByFamily,
  getAllDeployments,
  getFallbackChain,
  getAllModelAliases,
} from './deployments';
export type {
  DeploymentConfig,
  ModelFamily,
  ProtocolFamily,
  AzureAuthConfig,
  AzureAuthType,
} from './deployments';

export {
  getPricingByPattern,
  calculateCost,
  getAllPricingKeys,
  validatePricingData,
} from '../services/pricing.service';
export type { ModelPricing } from '../services/pricing.service';
