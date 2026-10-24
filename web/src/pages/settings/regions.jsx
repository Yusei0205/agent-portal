

/**
 * Current AWS commercial regions, sorted alphabetically by code.
 * Each entry: [regionCode, friendlyName]
 * Exported so that Repos.jsx and other pages can share them.
 */
export const AWS_REGIONS = [
  ['af-south-1', 'Africa (Cape Town)'],
  ['ap-east-1', 'Asia Pacific (Hong Kong)'],
  ['ap-northeast-1', 'Asia Pacific (Tokyo)'],
  ['ap-northeast-2', 'Asia Pacific (Seoul)'],
  ['ap-northeast-3', 'Asia Pacific (Osaka)'],
  ['ap-south-1', 'Asia Pacific (Mumbai)'],
  ['ap-south-2', 'Asia Pacific (Hyderabad)'],
  ['ap-southeast-1', 'Asia Pacific (Singapore)'],
  ['ap-southeast-2', 'Asia Pacific (Sydney)'],
  ['ap-southeast-3', 'Asia Pacific (Jakarta)'],
  ['ap-southeast-4', 'Asia Pacific (Melbourne)'],
  ['ap-southeast-5', 'Asia Pacific (Malaysia)'],
  ['ca-central-1', 'Canada (Central)'],
  ['ca-west-1', 'Canada West (Calgary)'],
  ['eu-central-1', 'Europe (Frankfurt)'],
  ['eu-central-2', 'Europe (Zurich)'],
  ['eu-north-1', 'Europe (Stockholm)'],
  ['eu-south-1', 'Europe (Milan)'],
  ['eu-south-2', 'Europe (Spain)'],
  ['eu-west-1', 'Europe (Ireland)'],
  ['eu-west-2', 'Europe (London)'],
  ['eu-west-3', 'Europe (Paris)'],
  ['il-central-1', 'Israel (Tel Aviv)'],
  ['me-central-1', 'Middle East (UAE)'],
  ['me-south-1', 'Middle East (Bahrain)'],
  ['mx-central-1', 'Mexico (Central)'],
  ['sa-east-1', 'South America (São Paulo)'],
  ['us-east-1', 'US East (N. Virginia)'],
  ['us-east-2', 'US East (Ohio)'],
  ['us-west-1', 'US West (N. California)'],
  ['us-west-2', 'US West (Oregon)'],
];

/**
 * A <select> for AWS regions.
 * Exported so that Repos.jsx and other pages can share it.
 * - If `value` is non-empty and not in the canonical list it is still shown as
 *   a selectable option so existing installs don't lose their saved value.
 */
export function RegionSelect({ id, value, onChange, className = 'input mono input-md', placeholder = 'Select a region…' }) {
  const knownCodes = AWS_REGIONS.map(([code]) => code);
  const showCustom = value && !knownCodes.includes(value);
  return (
    <select id={id} className={className} value={value} onChange={(e) => onChange(e.target.value)} aria-label="AWS region">
      <option value="" disabled>{placeholder}</option>
      {showCustom ? (
        <option value={value}>{value} (custom)</option>
      ) : null}
      {AWS_REGIONS.map(([code, name]) => (
        <option key={code} value={code}>{code} — {name}</option>
      ))}
    </select>
  );
}
