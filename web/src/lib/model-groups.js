/**
 * Model pickers list whatever the engine or AWS account returns, in the order it returned them (Bedrock sends Claude,
 * Llama, Stability and the rest mixed together). These put them in families, newest first inside Claude.
 */
const FAMILIES = [
  { name: 'Anthropic Claude', test: /claude|anthropic/i },
  { name: 'OpenAI', test: /\bgpt|openai|codex|\bo[134]\b/i },
  { name: 'Amazon Nova & Titan', test: /\bnova\b|titan|amazon\./i },
  { name: 'Meta Llama', test: /llama|meta\./i },
  { name: 'Mistral', test: /mistral|pixtral|mixtral/i },
  { name: 'DeepSeek', test: /deepseek/i },
  { name: 'Cohere', test: /cohere|\bcommand\b/i },
  { name: 'TwelveLabs', test: /twelvelabs|marengo|pegasus/i },
  { name: 'Stability AI', test: /stable image|stability|stable diffusion/i },
  { name: 'Qwen', test: /qwen/i },
  { name: 'AI21 Labs', test: /ai21|jamba|jurassic/i },
  { name: 'Writer', test: /writer|palmyra/i },
];
const OTHER = 'Other models';
const CLAUDE_TIERS = ['opus', 'sonnet', 'haiku'];

export function modelFamily(model) {
  const text = `${model?.id ?? ''} ${model?.label ?? ''}`;
  return FAMILIES.find((f) => f.test.test(text))?.name ?? OTHER;
}

/** Without the region prefix, so "US Claude 3 Haiku" and "EU Claude 3 Haiku" sort together. */
const bareLabel = (m) => String(m.label || m.id).replace(/^(us|eu|apac|global|jp|au)\s+/i, '').trim();
const collator = new Intl.Collator('en', { numeric: true, sensitivity: 'base' });

function claudeKey(m) {
  const text = bareLabel(m).toLowerCase();
  const tier = CLAUDE_TIERS.findIndex((t) => text.includes(t));
  return tier === -1 ? CLAUDE_TIERS.length : tier;
}

function compareWithin(family) {
  if (family !== 'Anthropic Claude') return (a, b) => collator.compare(bareLabel(a), bareLabel(b));
  // Opus, then Sonnet, then Haiku; the highest version first inside each.
  return (a, b) => claudeKey(a) - claudeKey(b) || collator.compare(bareLabel(b), bareLabel(a));
}

/** [{ name, models }] with the families in a fixed order (Claude first, "Other models" last) and the models sorted. */
export function groupModelsByFamily(models) {
  const byFamily = new Map();
  for (const m of models ?? []) {
    const name = modelFamily(m);
    if (!byFamily.has(name)) byFamily.set(name, []);
    byFamily.get(name).push(m);
  }
  const order = [...FAMILIES.map((f) => f.name), OTHER];
  return [...byFamily.entries()]
    .sort((a, b) => order.indexOf(a[0]) - order.indexOf(b[0]))
    .map(([name, list]) => ({ name, models: [...list].sort(compareWithin(name)) }));
}
