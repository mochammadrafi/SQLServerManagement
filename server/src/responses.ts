export function ok<T>(message: string, results: T | Record<string, never> = {}) {
  return { success: true, message, results };
}

export function fail(message: string, results: Record<string, unknown> = {}) {
  return { success: false, message, results };
}
