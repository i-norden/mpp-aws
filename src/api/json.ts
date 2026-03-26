export function serializeForJson<T>(value: T): unknown {
  return serializeValue(value, new WeakSet<object>());
}

function serializeValue(value: unknown, seen: WeakSet<object>): unknown {
  if (value === null || value === undefined) {
    return value;
  }

  if (typeof value === 'bigint') {
    return value.toString();
  }

  if (
    typeof value === 'string' ||
    typeof value === 'number' ||
    typeof value === 'boolean'
  ) {
    return value;
  }

  if (value instanceof Date) {
    return value.toISOString();
  }

  if (Array.isArray(value)) {
    return value.map((item) => serializeValue(item, seen));
  }

  if (value instanceof Set) {
    return Array.from(value, (item) => serializeValue(item, seen));
  }

  if (value instanceof Map) {
    return Object.fromEntries(
      Array.from(value.entries(), ([key, mapValue]) => [
        String(key),
        serializeValue(mapValue, seen),
      ]),
    );
  }

  if (typeof value === 'object') {
    if (seen.has(value)) {
      throw new TypeError('Cannot serialize circular object graph to JSON');
    }

    seen.add(value);

    try {
      if (typeof (value as { toJSON?: () => unknown }).toJSON === 'function') {
        return serializeValue(
          (value as { toJSON: () => unknown }).toJSON(),
          seen,
        );
      }

      const entries = Object.entries(value as Record<string, unknown>).map(
        ([key, nestedValue]) => [key, serializeValue(nestedValue, seen)],
      );

      return Object.fromEntries(entries);
    } finally {
      seen.delete(value);
    }
  }

  return String(value);
}
