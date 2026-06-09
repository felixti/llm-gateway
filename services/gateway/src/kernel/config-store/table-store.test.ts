import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockGetEntity = vi.fn();
const mockListEntities = vi.fn();
const mockUpsertEntity = vi.fn();

vi.mock('@azure/data-tables', () => ({
  TableClient: {
    fromConnectionString: vi.fn(() => ({
      getEntity: mockGetEntity,
      listEntities: mockListEntities,
      upsertEntity: mockUpsertEntity,
    })),
  },
}));

import { createTableConfigStore } from './table-store';

describe('createTableConfigStore', () => {
  beforeEach(() => {
    mockGetEntity.mockReset();
    mockListEntities.mockReset();
    mockUpsertEntity.mockReset();
  });

  it('getModel maps ADR-0011 model entity to ModelConfig', async () => {
    mockGetEntity.mockResolvedValueOnce({
      partitionKey: 'model',
      rowKey: 'gpt-5.4',
      provider: 'azure-openai',
      family: 'openai-chat',
      deploymentName: 'gpt-5.4-global',
      enabled: true,
      priceIn: '5.000000',
      priceOut: '15.000000',
      fallback: 'gpt-5.3-codex',
    });

    const store = createTableConfigStore({
      connectionString: 'UseDevelopmentStorage=true',
      tableName: 'aigatewayconfig',
    });

    await expect(store.getModel('gpt-5.4')).resolves.toEqual({
      alias: 'gpt-5.4',
      provider: 'azure-openai',
      family: 'openai-chat',
      deploymentName: 'gpt-5.4-global',
      enabled: true,
      priceInPerMillion: '5.000000',
      priceOutPerMillion: '15.000000',
      fallbackAlias: 'gpt-5.3-codex',
    });
    expect(mockGetEntity).toHaveBeenCalledWith('model', 'gpt-5.4');
  });

  it('getModel returns null when entity is missing', async () => {
    mockGetEntity.mockRejectedValueOnce({ statusCode: 404 });

    const store = createTableConfigStore({
      connectionString: 'UseDevelopmentStorage=true',
    });

    await expect(store.getModel('missing')).resolves.toBeNull();
  });

  it('getConfigVersion reads meta partition version row', async () => {
    mockGetEntity.mockResolvedValueOnce({
      partitionKey: 'meta',
      rowKey: 'version',
      version: 7,
    });

    const store = createTableConfigStore({
      connectionString: 'UseDevelopmentStorage=true',
    });

    await expect(store.getConfigVersion()).resolves.toBe(7);
    expect(mockGetEntity).toHaveBeenCalledWith('meta', 'version');
  });

  it('bumpConfigVersion increments and upserts meta version row', async () => {
    mockGetEntity.mockResolvedValueOnce({
      partitionKey: 'meta',
      rowKey: 'version',
      version: 3,
    });
    mockUpsertEntity.mockResolvedValueOnce(undefined);

    const store = createTableConfigStore({
      connectionString: 'UseDevelopmentStorage=true',
    });

    await expect(store.bumpConfigVersion()).resolves.toBe(4);
    expect(mockUpsertEntity).toHaveBeenCalledWith({
      partitionKey: 'meta',
      rowKey: 'version',
      version: 4,
    });
  });
});
