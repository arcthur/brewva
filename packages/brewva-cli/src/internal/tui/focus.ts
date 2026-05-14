export class FocusManager<TFocusOwner extends string = string> {
  #active: TFocusOwner;
  readonly #returnStack: TFocusOwner[] = [];

  constructor(initial: TFocusOwner) {
    this.#active = initial;
  }

  getActive(): TFocusOwner {
    return this.#active;
  }

  setActive(owner: TFocusOwner): void {
    this.#active = owner;
  }

  pushReturn(owner: TFocusOwner): void {
    this.#returnStack.push(owner);
  }

  restore(fallback?: TFocusOwner): TFocusOwner {
    const restored = this.#returnStack.pop() ?? fallback ?? this.#active;
    this.#active = restored;
    return restored;
  }
}
