// GS1 check-digit math (ported from @unidpp/resolver gs1dl.ts).

/** GS1 mod-10 check digit over the data digits (GTIN-8/12/13/14 forms). */
export function gs1CheckDigit(dataDigits: string): number {
  let sum = 0
  const padded = dataDigits.padStart(17, '0') // GS1 general rule: rightmost weight 3
  for (let i = padded.length - 1, weight = 3; i >= 0; i--, weight = weight === 3 ? 1 : 3) {
    sum += Number(padded[i]) * weight
  }
  return (10 - (sum % 10)) % 10
}

/** Validate a full GTIN (length 8/12/13/14) including its check digit. */
export function validGtin(gtin: string): boolean {
  if (!/^\d{8}$|^\d{12,14}$/.test(gtin)) return false
  const data = gtin.slice(0, -1)
  return gs1CheckDigit(data) === Number(gtin.slice(-1))
}
