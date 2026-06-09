import { Hono } from 'hono';

export const healthRoutes = new Hono();
healthRoutes.get('/health', (c) => c.json({ status: 'ok' }));
healthRoutes.get('/ready', (c) => c.json({ status: 'ready' }));
