export class SessionLocks {
  private readonly tails = new Map<string, Promise<void>>()

  async run<T>(id: string, action: () => Promise<T>): Promise<T> {
    const result = (this.tails.get(id) ?? Promise.resolve()).then(action)
    const tail = result.then(
      () => undefined,
      () => undefined,
    )
    this.tails.set(id, tail)
    try {
      return await result
    } finally {
      if (this.tails.get(id) === tail) {
        this.tails.delete(id)
      }
    }
  }
}

export class SessionSignals {
  private readonly active = new Map<string, Set<AbortController>>()

  async run<T>(id: string, action: (signal: AbortSignal) => Promise<T>): Promise<T> {
    const signals = this.active.get(id) ?? new Set<AbortController>()
    this.active.set(id, signals)
    const controller = new AbortController()
    signals.add(controller)
    try {
      return await action(controller.signal)
    } finally {
      signals.delete(controller)
      if (signals.size === 0 && this.active.get(id) === signals) {
        this.active.delete(id)
      }
    }
  }

  notify(id: string) {
    for (const controller of this.active.get(id) ?? []) {
      controller.abort()
    }
  }
}
