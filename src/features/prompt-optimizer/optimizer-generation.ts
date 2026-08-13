export const OPTIMIZER_GENERATION_STORAGE_KEY = 'screenpilot:optimizer-generation:v1'

let lastInMemoryGeneration = 0

function availableStorages(): Storage[] {
  const storages: Storage[] = []
  try {
    if (typeof sessionStorage !== 'undefined') storages.push(sessionStorage)
  } catch {
    // Storage access can be blocked in restricted webviews.
  }
  try {
    if (typeof localStorage !== 'undefined') storages.push(localStorage)
  } catch {
    // The in-memory floor still keeps a mounted page monotonic.
  }
  return storages
}

function persistedGeneration(): number {
  let persisted = 0
  for (const storage of availableStorages()) {
    try {
      const value = Number(storage.getItem(OPTIMIZER_GENERATION_STORAGE_KEY))
      if (Number.isSafeInteger(value) && value > persisted) persisted = value
    } catch {
      // Continue with the remaining storage and in-memory floors.
    }
  }
  return persisted
}

export function nextOptimizerGeneration(): number {
  const timeFloor = Math.max(1, Math.trunc(Date.now()) * 1000)
  const next = Math.max(timeFloor, persistedGeneration() + 1, lastInMemoryGeneration + 1)
  if (!Number.isSafeInteger(next) || next >= Number.MAX_SAFE_INTEGER) {
    throw new Error('Optimizer generation counter exhausted the JavaScript safe integer range')
  }
  lastInMemoryGeneration = next
  for (const storage of availableStorages()) {
    try {
      storage.setItem(OPTIMIZER_GENERATION_STORAGE_KEY, String(next))
    } catch {
      // A failed persistence write must not break optimization in this mount.
    }
  }
  return next
}
