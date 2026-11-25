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
