export function estimateTokensFromText(text: string): number {
  let asciiChars = 0;
  let higherCostChars = 0;

  for (const char of text) {
    if (char.charCodeAt(0) <= 0x7f) {
      asciiChars++;
    } else {
      higherCostChars++;
    }
  }

  return Math.ceil(asciiChars * 0.3 + higherCostChars * 0.6);
}
