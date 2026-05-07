export type BrewvaEventBusListener<TEvent, TMetadata = undefined> = (
  event: TEvent,
  metadata: TMetadata | undefined,
  signal: AbortSignal | undefined,
) => TEvent | void | Promise<TEvent | void>;

export interface BrewvaEventBus<TEvent, TMetadata = undefined> {
  subscribe(listener: BrewvaEventBusListener<TEvent, TMetadata>): () => void;
  listenerCount(): number;
}

export interface BrewvaEventBusController<TEvent, TMetadata = undefined> {
  emit(event: TEvent, metadata?: TMetadata, signal?: AbortSignal): Promise<TEvent>;
  clear(): void;
}

export interface BrewvaEventBusHandle<TEvent, TMetadata = undefined> {
  bus: BrewvaEventBus<TEvent, TMetadata>;
  controller: BrewvaEventBusController<TEvent, TMetadata>;
}

export interface CreateBrewvaEventBusOptions<TEvent> {
  normalizeEvent?: (event: TEvent) => TEvent;
  acceptReturnedEvent?: (input: { current: TEvent; returned: TEvent }) => boolean;
}

export function createBrewvaEventBus<TEvent, TMetadata = undefined>(
  options: CreateBrewvaEventBusOptions<TEvent> = {},
): BrewvaEventBusHandle<TEvent, TMetadata> {
  const listeners = new Set<BrewvaEventBusListener<TEvent, TMetadata>>();
  const normalizeEvent = options.normalizeEvent ?? ((event: TEvent) => event);
  const acceptReturnedEvent = options.acceptReturnedEvent ?? (() => true);

  const subscribe: BrewvaEventBus<TEvent, TMetadata>["subscribe"] = (listener) => {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  };
  const listenerCount = () => listeners.size;
  const bus: BrewvaEventBus<TEvent, TMetadata> = {
    subscribe,
    listenerCount,
  };
  const controller: BrewvaEventBusController<TEvent, TMetadata> = {
    async emit(event, metadata, signal) {
      let current = normalizeEvent(event);
      for (const listener of listeners) {
        const returned = await listener(current, metadata, signal);
        if (returned !== undefined && acceptReturnedEvent({ current, returned })) {
          current = normalizeEvent(returned);
        }
      }
      return current;
    },

    clear() {
      listeners.clear();
    },
  };

  return { bus, controller };
}
