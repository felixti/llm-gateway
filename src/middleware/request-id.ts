import type { Context, Next } from "hono";
import { v4 as uuidv4 } from "uuid";

const REQUEST_ID_HEADER = "X-Request-Id";

export async function requestIdMiddleware(c: Context, next: Next): Promise<void> {
  const id = uuidv4();
  c.set("requestId", id);
  c.header(REQUEST_ID_HEADER, id);
  await next();
}
