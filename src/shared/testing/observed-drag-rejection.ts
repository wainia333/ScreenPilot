export function observedDragRejection(onHandled: () => void): Promise<void> {
  const rejection = Promise.reject<undefined>(new Error('native drag failed'))
  void rejection.catch(() => undefined)
  return new Proxy(rejection, {
    get(target, property) {
      if (property === 'then') {
        return (
          onFulfilled?: ((value: undefined) => unknown) | null,
          onRejected?: ((reason: unknown) => unknown) | null,
        ) => {
          if (onRejected !== undefined && onRejected !== null) onHandled()
          return target.then(onFulfilled ?? undefined, onRejected ?? undefined)
        }
      }
      if (property === 'catch') {
        return (onRejected?: ((reason: unknown) => unknown) | null) => {
          if (onRejected !== undefined && onRejected !== null) onHandled()
          return target.catch(onRejected ?? undefined)
        }
      }
      const value = Reflect.get(target, property, target) as unknown
      if (typeof value !== 'function') return value
      return value.bind(target) as unknown
    },
  })
}
