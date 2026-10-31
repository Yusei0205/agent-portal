import { AWS_REGION_GROUPS, AWS_REGION_CODES } from '../lib/awsRegions.js';

/**
 * AWS region dropdown backed by the shared AWS_REGION_GROUPS list.
 *
 * Drop-in replacement for <input type="text"> region fields.
 * The stored value is the region code (e.g. "us-east-1"); no backend changes needed.
 *
 * Behaviour:
 * - Optional fields (required not set / false): always show a blank "— select region —" option.
 * - Required fields with a value: no blank option (the value is always set).
 * - Required fields that are initially empty: blank option shown until a choice is made.
 * - Legacy/unknown region codes: rendered as a "(current)" entry so existing saved values
 *   are preserved rather than silently cleared.
 *
 * Props mirror a native <select> element — id, value, onChange, required, disabled, etc.
 */
export function AwsRegionSelect({ id, value, onChange, required, disabled, ...rest }) {
  const isUnknown = value && !AWS_REGION_CODES.includes(value);
  // Show blank "— select region —" for optional fields, or for required fields not yet set.
  const showBlank = !required || !value;

  return (
    <select
      id={id}
      value={value}
      onChange={onChange}
      required={required}
      disabled={disabled}
      {...rest}
    >
      {showBlank && <option value="">— select region —</option>}
      {isUnknown && (
        <option value={value}>{value} (current)</option>
      )}
      {AWS_REGION_GROUPS.map((group) => (
        <optgroup key={group.label} label={group.label}>
          {group.regions.map((r) => (
            <option key={r.code} value={r.code}>
              {r.name} — {r.code}
            </option>
          ))}
        </optgroup>
      ))}
    </select>
  );
}
