/** Derived search terms preserve Chinese word fragments without a separate model. */
export function searchTerms(text: string): string[] {
  const terms = text.toLocaleLowerCase().match(/[a-z0-9]+|[\p{Script=Han}]+/gu) ?? [];
  return [...new Set(terms.flatMap(term => /\p{Script=Han}/u.test(term) && term.length > 1 ? Array.from({ length: term.length - 1 }, (_, index) => term.slice(index, index + 2)) : [term]))];
}

export function scoreText(text: string, terms: string[]): number {
  const normalized = text.toLocaleLowerCase();
  return terms.reduce((score, term) => score + (normalized.includes(term) ? 1 : 0), 0);
}
