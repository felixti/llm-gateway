import {
  type AzureAuthConfig,
  type DeploymentConfig,
  getDeploymentByAlias,
} from '@/config/deployments';

// Constants for token refresh
const TOKEN_REFRESH_BUFFER_SECONDS = 300; // 5 minutes before expiry

// JWT payload interface for expiry extraction
interface JwtPayload {
  exp: number;
  iat: number;
}

/**
 * Decode JWT and extract expiration timestamp
 */
function decodeJwtExp(token: string): number | null {
  try {
    const parts = token.split('.');
    if (parts.length !== 3) return null;
    const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf-8')) as JwtPayload;
    return payload.exp ?? null;
  } catch {
    return null;
  }
}

/**
 * Check if token needs proactive refresh
 */
function needsProactiveRefresh(exp: number): boolean {
  const now = Math.floor(Date.now() / 1000);
  return exp - now < TOKEN_REFRESH_BUFFER_SECONDS;
}

// Cached token entry
interface CachedToken {
  accessToken: string;
  expiresAt: number;
}

/**
 * Azure Auth Manager - handles Entra ID and API Key authentication
 * for Azure OpenAI and Azure AI Foundry deployments
 */
export class AzureAuthManager {
  private tokenCache: Map<string, CachedToken>;
  private pendingFetches: Map<string, Promise<string>>;
  private fetchFn: typeof fetch;

  constructor(fetchFn: typeof fetch = fetch) {
    this.tokenCache = new Map();
    this.pendingFetches = new Map();
    this.fetchFn = fetchFn;
  }

  /**
   * Get authentication headers for a deployment
   */
  async getAuthHeaders(deploymentName: string): Promise<Record<string, string>> {
    const deployment = getDeploymentByAlias(deploymentName);
    if (!deployment) {
      throw new Error(`Deployment not found: ${deploymentName}`);
    }
    return this.getAuthHeadersForDeployment(deployment);
  }

  /**
   * Get auth headers for a specific deployment config
   */
  async getAuthHeadersForDeployment(deployment: DeploymentConfig): Promise<Record<string, string>> {
    const { authConfig } = deployment;

    if (authConfig.type === 'api-key') {
      return this.getApiKeyHeaders(authConfig);
    }
    return this.getEntraIdHeaders(authConfig);
  }

  /**
   * API Key authentication headers
   */
  private getApiKeyHeaders(config: AzureAuthConfig): Record<string, string> {
    const { apiKey, keyHeader } = config;
    if (!apiKey) {
      throw new Error('API key not configured for deployment');
    }

    switch (keyHeader) {
      case 'Authorization':
        return { Authorization: `Bearer ${apiKey}` };
      case 'x-api-key':
        return { 'x-api-key': apiKey };
      default:
        return { 'api-key': apiKey };
    }
  }

  /**
   * Entra ID authentication - client credentials flow with caching
   */
  private async getEntraIdHeaders(config: AzureAuthConfig): Promise<Record<string, string>> {
    const tenantId = config.tenantId;
    const clientId = config.clientId;
    const clientSecret = config.clientSecret;
    const scope = config.scope;

    if (!tenantId || !clientId || !clientSecret) {
      throw new Error('Entra ID credentials not fully configured');
    }

    const cacheKey = `${tenantId}:${clientId}:${scope}`;
    const cached = this.tokenCache.get(cacheKey);

    // Check cache first
    if (cached && !needsProactiveRefresh(cached.expiresAt)) {
      return { Authorization: `Bearer ${cached.accessToken}` };
    }

    // Check if a fetch is already in-flight for this cacheKey (single-flight deduplication)
    const existingFetch = this.pendingFetches.get(cacheKey);
    if (existingFetch) {
      const token = await existingFetch;
      return { Authorization: `Bearer ${token}` };
    }

    // Create new fetch and track it in pendingFetches
    const fetchPromise = this.fetchEntraToken(tenantId, clientId, clientSecret, scope ?? '');
    this.pendingFetches.set(cacheKey, fetchPromise);

    let token: string;
    try {
      token = await fetchPromise;
    } finally {
      this.pendingFetches.delete(cacheKey);
    }

    // Decode expiry from JWT
    const exp = decodeJwtExp(token);
    if (exp === null) {
      throw new Error('Failed to decode token expiry');
    }

    // Cache the token
    this.tokenCache.set(cacheKey, {
      accessToken: token,
      expiresAt: exp,
    });

    return { Authorization: `Bearer ${token}` };
  }

  /**
   * Fetch Entra ID token via client credentials flow
   */
  private async fetchEntraToken(
    tenantId: string,
    clientId: string,
    clientSecret: string,
    scope: string
  ): Promise<string> {
    const tokenUrl = `https://login.microsoftonline.com/${tenantId}/oauth2/v2.0/token`;

    const body = new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: clientId,
      client_secret: clientSecret,
      scope,
    });

    const response = await this.fetchFn(tokenUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`Entra ID token fetch failed: ${response.status} ${error}`);
    }

    const data = (await response.json()) as { access_token: string };
    return data.access_token;
  }

  /**
   * Clear token cache (useful for testing or forced refresh)
   */
  clearCache(): void {
    this.tokenCache.clear();
  }

  /**
   * Clear specific deployment's token
   */
  clearToken(deploymentName: string): void {
    const deployment = getDeploymentByAlias(deploymentName);
    if (!deployment || deployment.authConfig.type !== 'entra-id') return;

    const { tenantId, clientId, scope } = deployment.authConfig;
    if (tenantId && clientId && scope) {
      const cacheKey = `${tenantId}:${clientId}:${scope}`;
      this.tokenCache.delete(cacheKey);
    }
  }
}

// Singleton instance
let authManagerInstance: AzureAuthManager | null = null;

/**
 * Get singleton AzureAuthManager instance
 */
export function getAzureAuthManager(): AzureAuthManager {
  if (!authManagerInstance) {
    authManagerInstance = new AzureAuthManager();
  }
  return authManagerInstance;
}

/**
 * Create new AzureAuthManager instance (for testing)
 * @internal
 */
export function createAzureAuthManager(fetchFn?: typeof fetch): AzureAuthManager {
  return new AzureAuthManager(fetchFn);
}
