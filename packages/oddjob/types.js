/* © 2020 Robert Grimm */

const { has: MapHas } = Map.prototype;
const { has: SetHas } = Set.prototype;
const { toString } = Object.prototype;

export function isMap(value) {
  try {
    MapHas.call(value);
    return true;
  } catch {
    return false;
  }
}

export function isSet(value) {
  try {
    SetHas.call(value);
    return true;
  } catch {
    return false;
  }
}

export function isURL(value) {
  return value instanceof URL || toString.call(value) === '[object URL]';
}

const Boxed = new Set(['BigInt', 'Boolean', 'Number', 'String']);

export function isBoxed(value) {
  return (
    value != null &&
    typeof value === 'object' &&
    Boxed.has(toString.call(value).slice(8, -1))
  );
}
