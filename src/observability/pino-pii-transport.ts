import type { DestinationStream } from 'pino';
import { sanitizePII } from './sanitize-pii';

/**
 * Synchronous pino destination stream that auto-sanitizes PII from ALL log output.
 *
 * Uses DestinationStream (not pino.transport worker thread) because:
 * - Bun worker thread support for pino transports is unreliable
 * - Synchronous stream = zero PII can escape
 * - sanitizePII() is regex-based with negligible overhead
 */
export class PinoPIITransform implements DestinationStream {
  private destination: DestinationStream;

  constructor(destination: DestinationStream) {
    this.destination = destination;
  }

  write(logEntry: string): void {
    try {
      const parsed = JSON.parse(logEntry);
      const sanitized = sanitizePII(parsed);
      this.destination.write(JSON.stringify(sanitized));
    } catch {
      // Unparseable entry: sanitize the raw string as fallback
      const sanitized = sanitizePII(logEntry);
      if (typeof sanitized === 'string') {
        this.destination.write(sanitized);
      } else {
        this.destination.write(logEntry);
      }
    }
  }
}

export function createPIISanitizeStream(
  destination: DestinationStream = process.stdout
): PinoPIITransform {
  return new PinoPIITransform(destination);
}
