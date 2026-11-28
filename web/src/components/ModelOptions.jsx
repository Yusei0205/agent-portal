import { groupModelsByFamily } from '../lib/model-groups.js';

/** The <option>s of a model picker, grouped by model family (flat when every model is from one family). */
export default function ModelOptions({ models }) {
  const groups = groupModelsByFamily(models);
  const option = (m) => <option key={m.id} value={m.id}>{m.label || m.id}</option>;
  if (groups.length <= 1) return <>{(groups[0]?.models ?? []).map(option)}</>;
  return <>{groups.map((g) => <optgroup key={g.name} label={g.name}>{g.models.map(option)}</optgroup>)}</>;
}
