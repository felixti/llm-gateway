import { TableClient } from '@azure/data-tables';
import type {
  BudgetPolicy,
  ModelConfig,
  ModelProvider,
  PrincipalRecord,
  ProtocolFamily,
  UpstreamApi,
} from '@shared/contracts/tenant';
import type { PrincipalKind } from '@shared/contracts/claims';
import type { ConfigStore } from './types';

const MODEL_PARTITION = 'model';
const PRINCIPAL_PARTITION = 'principal';
const META_PARTITION = 'meta';
const META_VERSION_ROW = 'version';

type TableEntity = Record<string, unknown> & {
  partitionKey: string;
  rowKey: string;
};

export type TableConfigStoreOptions = {
  connectionString: string;
  tableName?: string;
};

function parseModelAllowlist(raw: unknown): string[] {
  if (Array.isArray(raw)) {
    return raw.filter((item): item is string => typeof item === 'string');
  }
  if (typeof raw === 'string') {
    try {
      const parsed = JSON.parse(raw) as unknown;
      return Array.isArray(parsed)
        ? parsed.filter((item): item is string => typeof item === 'string')
        : [];
    } catch {
      return raw.split(',').map((item) => item.trim()).filter(Boolean);
    }
  }
  return [];
}

function entityToModel(entity: TableEntity): ModelConfig {
  const family = entity.family as ProtocolFamily;
  const upstreamRaw = entity.upstreamApi ?? entity.upstream_api;
  const upstreamApi: UpstreamApi =
    upstreamRaw === 'responses' || upstreamRaw === 'chat-completions'
      ? upstreamRaw
      : family === 'openai-responses'
        ? 'responses'
        : 'chat-completions';

  const model: ModelConfig = {
    alias: entity.rowKey,
    provider: entity.provider as ModelProvider,
    family,
    upstreamApi,
    deploymentName: String(entity.deploymentName ?? entity.rowKey),
    enabled: Boolean(entity.enabled),
    priceInPerMillion: String(entity.priceIn ?? entity.priceInPerMillion ?? '0'),
    priceOutPerMillion: String(entity.priceOut ?? entity.priceOutPerMillion ?? '0'),
  };
  const fallback = entity.fallback ?? entity.fallbackAlias;
  if (typeof fallback === 'string' && fallback.length > 0) {
    model.fallbackAlias = fallback;
  }
  return model;
}

function entityToPrincipal(entity: TableEntity): PrincipalRecord {
  return {
    principalId: entity.rowKey,
    kind: String(entity.kind) as PrincipalKind,
    projectId: entity.project_id == null || entity.project_id === ''
      ? null
      : String(entity.project_id),
    orgId: String(entity.org_id ?? entity.orgId ?? 'internal'),
    modelAllowlist: parseModelAllowlist(entity.model_allowlist ?? entity.modelAllowlist),
  };
}

function entityToBudget(entity: TableEntity, scopeKind: 'user' | 'project'): BudgetPolicy {
  return {
    principalId: entity.rowKey,
    scopeKind,
    capUsd: String(entity.cap_usd ?? entity.capUsd ?? '0'),
    period: entity.period === 'daily' ? 'daily' : 'monthly',
    hard: entity.hard !== false && entity.hard !== 'false',
  };
}

export function createTableConfigStore(opts: TableConfigStoreOptions): ConfigStore {
  const tableName = opts.tableName ?? 'aigatewayconfig';
  const client = TableClient.fromConnectionString(opts.connectionString, tableName);

  async function readVersion(): Promise<number> {
    try {
      const entity = (await client.getEntity(META_PARTITION, META_VERSION_ROW)) as TableEntity;
      const version = Number(entity.version ?? entity.configVersion ?? 1);
      return Number.isFinite(version) && version > 0 ? version : 1;
    } catch (err: unknown) {
      if (isNotFound(err)) {
        return 1;
      }
      throw err;
    }
  }

  return {
    async getModel(alias) {
      try {
        const entity = (await client.getEntity(MODEL_PARTITION, alias)) as TableEntity;
        return entityToModel(entity);
      } catch (err: unknown) {
        if (isNotFound(err)) {
          return null;
        }
        throw err;
      }
    },

    async listModels() {
      const models: ModelConfig[] = [];
      for await (const entity of client.listEntities<TableEntity>({
        queryOptions: { filter: `PartitionKey eq '${MODEL_PARTITION}'` },
      })) {
        models.push(entityToModel(entity));
      }
      return models;
    },

    async getPrincipal(principalId) {
      try {
        const entity = (await client.getEntity(PRINCIPAL_PARTITION, principalId)) as TableEntity;
        return entityToPrincipal(entity);
      } catch (err: unknown) {
        if (isNotFound(err)) {
          return null;
        }
        throw err;
      }
    },

    async getBudgetPolicy(principalId, scopeKind) {
      try {
        const entity = (await client.getEntity(scopeKind, principalId)) as TableEntity;
        return entityToBudget(entity, scopeKind);
      } catch (err: unknown) {
        if (isNotFound(err)) {
          return null;
        }
        throw err;
      }
    },

    async getConfigVersion() {
      return readVersion();
    },

    async bumpConfigVersion() {
      const next = (await readVersion()) + 1;
      await client.upsertEntity({
        partitionKey: META_PARTITION,
        rowKey: META_VERSION_ROW,
        version: next,
      });
      return next;
    },
  };
}

function isNotFound(err: unknown): boolean {
  return (
    typeof err === 'object'
    && err !== null
    && 'statusCode' in err
    && (err as { statusCode?: number }).statusCode === 404
  );
}

export function createTableConfigStoreFromEnv(): ConfigStore {
  const connectionString = process.env.AZURE_TABLE_CONNECTION_STRING;
  if (!connectionString) {
    throw new Error('AZURE_TABLE_CONNECTION_STRING is required for table config store');
  }
  return createTableConfigStore({
    connectionString,
    tableName: process.env.CONFIG_TABLE_NAME ?? 'aigatewayconfig',
  });
}
