export type BarcodeClassification =
  | { kind: "valid" }
  | { kind: "empty" }
  | { kind: "fixable"; fixed: string }
  | { kind: "unfixable" };

/**
 * A valid barcode is exactly 12 digits. Anything else we try to repair:
 * - strip non-digits; exactly 12 digits left is fine as-is
 * - too short: prefix with "72" and as many zeroes as needed to reach 12
 * - too long (11 or more than 12 digits): keep the rightmost 10 digits and
 *   prefix with "72"
 * - no digits at all (or empty): a fresh barcode must be generated
 */
export function classifyBarcode(
  raw: string | null | undefined,
): BarcodeClassification {
  const trimmed = (raw ?? "").trim();
  if (!trimmed) return { kind: "empty" };
  if (/^\d{12}$/.test(trimmed)) return { kind: "valid" };

  const digits = trimmed.replace(/\D+/g, "");
  if (digits.length === 0) return { kind: "unfixable" };
  if (digits.length === 12) return { kind: "fixable", fixed: digits };
  if (digits.length > 10) return { kind: "fixable", fixed: `72${digits.slice(-10)}` };
  return {
    kind: "fixable",
    fixed: "72" + "0".repeat(10 - digits.length) + digits,
  };
}

export function isValidGeneratorSeed(barcode: string): boolean {
  return /^71\d{10}$/.test(barcode);
}

export function incrementBarcode(barcode: string): string {
  const next = (BigInt(barcode) + 1n).toString().padStart(12, "0");
  if (next.length > 12) {
    throw new Error(`Cannot increment barcode ${barcode}: 12-digit space exhausted.`);
  }
  return next;
}
