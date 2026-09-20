/**
 * Counted nouns for text a person reads.
 *
 * Every one of these strings reaches a report, a blocking reason, or a pull request body, and
 * "this repository reaches it in 1 place(s)" is the sort of thing that makes a reader trust the
 * rest of the sentence less. There is no general pluralisation here and there should not be: the
 * words this project counts are known, and an irregular one is passed explicitly.
 */
export function count(amount: number, singular: string, plural = `${singular}s`): string {
  return `${String(amount)} ${amount === 1 ? singular : plural}`;
}
