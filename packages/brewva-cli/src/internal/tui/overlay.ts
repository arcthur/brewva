export type OverlayPriority = "normal" | "queued";

export interface OverlayEntry<TFocusOwner extends string = string> {
  id: string;
  kind: string;
  focusOwner: TFocusOwner;
  priority: OverlayPriority;
  suspendFocusOwner?: TFocusOwner;
}

export class OverlayManager<TFocusOwner extends string = string> {
  #active: OverlayEntry<TFocusOwner> | undefined;
  readonly #queue: Array<OverlayEntry<TFocusOwner>> = [];

  open(entry: OverlayEntry<TFocusOwner>): void {
    if (!this.#active) {
      this.#active = entry;
      return;
    }
    if (entry.suspendFocusOwner) {
      this.#queue.unshift(this.#active);
      this.#active = entry;
      return;
    }
    if (entry.priority === "queued") {
      this.#queue.push(entry);
      return;
    }
    this.#active = entry;
  }

  close(id: string): OverlayEntry<TFocusOwner> | undefined {
    if (this.#active?.id === id) {
      const closed = this.#active;
      this.#active = this.#queue.shift();
      return closed;
    }
    const index = this.#queue.findIndex((entry) => entry.id === id);
    if (index >= 0) {
      return this.#queue.splice(index, 1)[0];
    }
    return undefined;
  }

  getActive(): OverlayEntry<TFocusOwner> | undefined {
    return this.#active;
  }

  getQueued(): readonly OverlayEntry<TFocusOwner>[] {
    return this.#queue;
  }
}
