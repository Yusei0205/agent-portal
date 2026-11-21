import { Icon } from './Icon.jsx';

/** The exclamation marker for API simulation: "something here needs a person to look at it". Never an error. */
export function FlagBadge({ flags, compact = false }) {
  if (!flags || flags.warnings === 0) return null;
  const label = flags.missingPath ? 'URL path needed' : `${flags.warnings} to check`;
  return (
    <span className="sim-flag" title={`${flags.warnings} item${flags.warnings === 1 ? '' : 's'} need a look before you rely on this API`}>
      <Icon name="warning" size={13} />
      {!compact && <span>{label}</span>}
    </span>
  );
}

export default FlagBadge;
