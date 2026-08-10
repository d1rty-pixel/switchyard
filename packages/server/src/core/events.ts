import { EventEmitter } from 'node:events';
import type { ActionRecord, ServiceState } from '../types.js';
import type { ServiceSummary } from './views.js';

/**
 * Server-sent-event payloads. The frontend patches its cache from these instead
 * of polling the whole service list.
 */
export type SwitchyardEvent =
  | { type: 'service:update'; service: ServiceSummary }
  | { type: 'service:checked'; id: string; state: ServiceState; checkedAt: string }
  | { type: 'action:start'; id: string; actionId: string; label: string; startedAt: string }
  | { type: 'action:end'; id: string; actionId: string; record: ActionRecord }
  | { type: 'config:reload'; services: number; at: string }
  | { type: 'ready'; at: string };

export class EventBus {
  private readonly emitter = new EventEmitter({ captureRejections: true });

  constructor() {
    // A dashboard tab per monitor plus a stray curl should never warn.
    this.emitter.setMaxListeners(64);
  }

  emit(event: SwitchyardEvent): void {
    this.emitter.emit('event', event);
  }

  subscribe(listener: (event: SwitchyardEvent) => void): () => void {
    this.emitter.on('event', listener);
    return () => this.emitter.off('event', listener);
  }

  get subscriberCount(): number {
    return this.emitter.listenerCount('event');
  }
}
