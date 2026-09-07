import { adjectives, animals, colors, uniqueNamesGenerator } from "unique-names-generator";

export function planReference(planId: string): string {
  return uniqueNamesGenerator({
    dictionaries: [adjectives, colors, animals],
    separator: "-",
    length: 3,
    seed: planId,
  });
}
