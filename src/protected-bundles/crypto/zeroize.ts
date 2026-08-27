export async function withZeroizedBytes<T>(
  secret: Uint8Array,
  operation: (secret: Uint8Array) => Promise<T>,
): Promise<T> {
  try {
    return await operation(secret);
  } finally {
    secret.fill(0);
  }
}
