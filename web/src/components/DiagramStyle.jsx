/**
 * Style + cloud picker for diagram creation and editing.
 *
 * @param {{
 *   style: 'mermaid' | 'icon',
 *   cloud: string,
 *   onChange: (style: string, cloud: string) => void,
 *   packsAvailable: boolean,
 * }} props
 */
export function DiagramStyle({ style, cloud, onChange, packsAvailable = false }) {
  const CLOUDS = [
    { id: 'aws',        label: 'AWS' },
    { id: 'azure',      label: 'Azure' },
    { id: 'gcp',        label: 'Google Cloud' },
    { id: 'kubernetes', label: 'Kubernetes' },
    { id: 'generic',    label: 'Generic (no single cloud)' },
  ];

  const handleStyleChange = (newStyle) => {
    const newCloud = newStyle === 'icon' && !cloud ? 'aws' : cloud;
    onChange(newStyle, newCloud);
  };

  const handleCloudChange = (newCloud) => {
    onChange(style, newCloud);
  };

  return (
    <div className="diagram-style-picker stack gap-sm">
      <div className="field">
        <span className="field-label">Style</span>
        <div className="radio-group" role="radiogroup" aria-label="Diagram style">
          <label className="radio-label">
            <input
              type="radio"
              name="diagram-style"
              value="mermaid"
              checked={style === 'mermaid'}
              onChange={() => handleStyleChange('mermaid')}
            />
            <span>Mermaid (text diagram)</span>
          </label>
          <label className={`radio-label ${!packsAvailable ? 'radio-disabled' : ''}`}>
            <input
              type="radio"
              name="diagram-style"
              value="icon"
              checked={style === 'icon'}
              onChange={() => handleStyleChange('icon')}
              disabled={!packsAvailable}
            />
            <span>
              Icon diagram (draw.io, official cloud icons)
              {!packsAvailable && (
                <span className="field-hint">
                  {' '}Icon diagrams use official cloud provider icons. Requires Icon diagrams pack.
                </span>
              )}
            </span>
          </label>
        </div>
      </div>

      {style === 'icon' && (
        <div className="field">
          <label htmlFor="diagram-cloud">Cloud</label>
          <select
            id="diagram-cloud"
            value={cloud || 'aws'}
            onChange={(e) => handleCloudChange(e.target.value)}
          >
            {CLOUDS.map((c) => (
              <option key={c.id} value={c.id}>{c.label}</option>
            ))}
          </select>
          <p className="field-hint">
            Icon diagrams use official cloud provider icons. Requires Icon diagrams pack.
          </p>
        </div>
      )}
    </div>
  );
}
