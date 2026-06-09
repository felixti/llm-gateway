import { GenericContainer, type StartedTestContainer, Wait } from 'testcontainers';

let redisContainer: StartedTestContainer | null = null;
let postgresContainer: StartedTestContainer | null = null;

export async function startTestContainers(): Promise<{ redisUrl: string; postgresUrl: string }> {
  redisContainer = await new GenericContainer('redis:7-alpine')
    .withExposedPorts(6379)
    .withWaitStrategy(Wait.forLogMessage('Ready to accept connections'))
    .start();

  postgresContainer = await new GenericContainer('postgres:16-alpine')
    .withExposedPorts(5432)
    .withEnvironment({
      POSTGRES_USER: 'test',
      POSTGRES_PASSWORD: 'test',
      POSTGRES_DB: 'llm_gateway',
    })
    .withWaitStrategy(Wait.forLogMessage('database system is ready to accept connections'))
    .start();

  return {
    redisUrl: `redis://${redisContainer.getHost()}:${redisContainer.getMappedPort(6379)}`,
    postgresUrl: `postgresql://test:test@${postgresContainer.getHost()}:${postgresContainer.getMappedPort(5432)}/llm_gateway`,
  };
}

export async function stopTestContainers(): Promise<void> {
  if (redisContainer) {
    await redisContainer.stop();
    redisContainer = null;
  }
  if (postgresContainer) {
    await postgresContainer.stop();
    postgresContainer = null;
  }
}
