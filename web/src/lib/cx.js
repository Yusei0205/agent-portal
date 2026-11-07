/**
 * Classname helper — combines class names, filtering falsy values.
 * Handles: strings, objects {className: bool}, arrays, falsy values.
 *
 * @param {...(string|boolean|null|undefined|Object|Array)} args
 * @returns {string}
 */
export default function cx(...args) {
  /** @type {string[]} */
  const classes = [];
  for (const arg of args) {
    if (!arg) continue;
    if (typeof arg === 'string') {
      classes.push(arg);
    } else if (Array.isArray(arg)) {
      const nested = cx(...arg);
      if (nested) classes.push(nested);
    } else if (typeof arg === 'object') {
      for (const [key, val] of Object.entries(arg)) {
        if (val) classes.push(key);
      }
    }
  }
  return classes.join(' ');
}
