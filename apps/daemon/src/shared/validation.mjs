/** Validate human-authored text at a transport or module seam. */
export function requiredText(value, label, max = 12000, allowEmpty = false) {
  if (
    typeof value !== 'string' ||
    (!allowEmpty && !value.trim()) ||
    value.length > max
  ) {
    throw new Error(`${label} is required and must be at most ${max} characters.`);
  }
  return value.trim();
}
