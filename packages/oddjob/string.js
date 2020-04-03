/* © 2020 Robert Grimm */

const { create } = Object;

// Overrides to be applied before NFKD normalization written as equivalence
// classes with source characters following their replacement.
const OVERRIDES = [
  ['Aa', 'Å'],
  ['aa', 'å'],
  ['Ae', 'Ä', 'Æ', 'Ǽ', 'Ǣ'],
  ['ae', 'ä', 'æ', 'ǽ', 'ǣ'],
  ['(C)', '©'],
  ['D', 'Ð'],
  ['d', 'ð'],
  ['H', 'Ħ'],
  ['h', 'ħ'],
  ['Hv', 'Ƕ'],
  ['hv', 'ƕ'],
  ['L', 'Ł'],
  ['l', 'ł'],
  ['Oe', 'Ø', 'Ö', 'Œ'],
  ['oe', 'ø', 'ö', 'œ'],
  ['pH', '㏗'],
  ['(R)', '®'],
  ['SS', 'ẞ'], // Two capitalized 'S' characters indeed!
  ['ss', 'ß'],
  ['Ue', 'Ü'],
  ['ue', 'ü'],
  ['w', 'Ƿ'],
  ['+/-', '±'],
  ['<<', '«'],
  ['>>', '»'],
  ['*', '×'],
  ['/', '÷'],
];

// Corrections to be applied after NFKD normalization.
const CORRECTIONS = [
  [`'`, '\u02BC', '\u02BE'],
  ['/', '\u2215'],
  ['-', '\u2010', '\u2013', '\u2014'],
];

// Convert equivalence classes into a predicate matching original characters.
const toPredicate = equivalences => {
  const chars = equivalences.flatMap(alt => alt.slice(1)).join('');
  return new RegExp(`[${chars}]`, `gu`);
};

// Convert equivalence classes into object mapping originals to replacements.
const toTable = equivalences => {
  const table = create(null);
  for (const [value, ...keys] of equivalences) {
    for (const key of keys) {
      table[key] = value;
    }
  }
  return table;
};

const IS_OVERRIDE = toPredicate(OVERRIDES);
const GET_OVERRIDE = toTable(OVERRIDES);
const IS_CORRECTION = toPredicate(CORRECTIONS);
const GET_CORRECTION = toTable(CORRECTIONS);
const IS_DIACRITIC = /[\u0300-\u036f]/gu;
const IS_DASHING_SPACING = /[\s-]+/gu;
const IS_NOT_SLUG_SAFE = /[^-a-z0-9_]/gu;

/** Convert the given extended Latin text to its ASCII equivalent. */
export function asciify(text) {
  return text
    .replace(IS_OVERRIDE, c => GET_OVERRIDE[c])
    .normalize('NFKD')
    .replace(IS_DIACRITIC, '')
    .replace(IS_CORRECTION, c => GET_CORRECTION[c]);
}

/** Convert the given extended Latin text to a slug. */
export function slugify(text) {
  return asciify(text)
    .toLowerCase()
    .replace(IS_DASHING_SPACING, '-')
    .replace(IS_NOT_SLUG_SAFE, '');
}