export type BrewvaEventBusListener<TEvent> = (
  event: TEvent,
) => TEvent | void | Promise<TEvent | void>;

export interface BrewvaEventBus<TEvent> {
  subscribe(listener: BrewvaEventBusListener<TEvent>): () => void;
  listenerCount(): number;
}

export interface BrewvaEventBusController<TEvent> {
  emit(event: TEvent): Promise<TEvent>;
  clear(): void;
}

export interface BrewvaEventBusHandle<TEvent> {
  bus: BrewvaEventBus<TEvent>;
  controller: BrewvaEventBusController<TEvent>;
}

export interface CreateBrewvaEventBusOptions<TEvent> {
  normalizeEvent?: (event: TEvent) => TEvent;
  acceptReturnedEvent?: (input: { current: TEvent; returned: TEvent }) => boolean;
}

export function createBrewvaEventBus<TEvent>(
  options: CreateBrewvaEventBusOptions<TEvent> = {},
): BrewvaEventBusHandle<TEvent> {
  const listeners = new Set<BrewvaEventBusListener<TEvent>>();
  const normalizeEvent = options.normalizeEvent ?? ((event: TEvent) => event);
  const acceptReturnedEvent = options.acceptReturnedEvent ?? (() => true);

  const subscribe: BrewvaEventBus<TEvent>["subscribe"] = (listener) => {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  };
  const listenerCount = () => listeners.size;
  const bus: BrewvaEventBus<TEvent> = {
    subscribe,
    listenerCount,
  };
  const controller: BrewvaEventBusController<TEvent> = {
    async emit(event) {
      let current = normalizeEvent(event);
      for (const listener of listeners) {
        const returned = await listener(current);
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
