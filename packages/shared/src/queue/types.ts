export interface QueueMessage {
  id: string;
  popReceipt: string;
  body: string;
  dequeueCount: number;
}

export interface UsageQueue {
  enqueue(body: string): Promise<void>;
  receive(maxMessages: number, visibilityTimeoutSec: number): Promise<QueueMessage[]>;
  deleteMessage(id: string, popReceipt: string): Promise<void>;
}
