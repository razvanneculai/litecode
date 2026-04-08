let encoder: { encode: (text: string) => Uint32Array } | null = null;
let encoderFailed = false;

async function getEncoder() {
  if (encoderFailed) return null;
  if (encoder) return encoder;
  try {
    const { get_encoding } = await import("tiktoken");
    encoder = get_encoding("cl100k_base");
  } catch {
    encoderFailed = true;
    return null;
  }
  return encoder;
}

export async function countTokensAsync(text: string): Promise<number> {
  const enc = await getEncoder();
  if (enc) {
    return enc.encode(text).length;
  }
  return Math.ceil(text.length / 3.5);
}

// Synchronous version using character fallback (used when async isn't convenient)
export function countTokens(text: string): number {
  if (encoder) {
    return encoder.encode(text).length;
  }
  return Math.ceil(text.length / 3.5);
}

// Call this once at startup to warm up the encoder
export async function initEncoder(): Promise<void> {
  await getEncoder();
}
