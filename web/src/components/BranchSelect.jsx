import { useState } from 'react';

/** Repository branches are selectable without typing; custom refs remain available explicitly. */
export function BranchSelect({ id, value, branches = [], loading = false, onChange, required = false, describedBy }) {
  const [manual, setManual] = useState(false);
  const options = [...new Set([...branches, ...(value ? [value] : [])])];
  return (
    <>
      {manual ? (
        <input id={id} type="text" value={value} onChange={(e) => onChange(e.target.value)}
          placeholder="Branch, tag or commit ref" autoComplete="off" required={required} aria-describedby={describedBy} />
      ) : (
        <select id={id} value={value} onChange={(e) => onChange(e.target.value)}
          disabled={loading} required={required} aria-describedby={describedBy}>
          <option value="">{loading ? 'Loading branches…' : 'Select a branch'}</option>
          {options.map((branch) => <option key={branch} value={branch}>{branch}</option>)}
        </select>
      )}
      <button type="button" className="btn-link" onClick={() => setManual((v) => !v)}>
        {manual ? 'Choose from branches' : 'Enter a ref instead'}
      </button>
    </>
  );
}
