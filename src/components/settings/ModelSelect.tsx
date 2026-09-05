import { useId, useState } from 'react';
import type { HermesModel } from '../../services/hermes/types';

export function ModelSelect({ label, value, models, defaultLabel, onChange }: {
  label: string;
  value: string;
  models: HermesModel[];
  defaultLabel: string;
  onChange: (value: string) => void;
}) {
  const id = useId();
  const [manual, setManual] = useState(false);
  return <div className="field">
    <label htmlFor={id}>{label}</label>
    <select id={id} className="select" value={value} onChange={(e) => onChange(e.target.value)}>
      <option value="">{defaultLabel}</option>
      {value && !models.some((m) => m.id === value) && <option value={value}>{value} (configuré)</option>}
      {models.map((m) => <option key={m.id} value={m.id} disabled={m.available === false}>{m.name || m.id}{m.provider || m.owned_by ? ` · ${m.provider || m.owned_by}` : ''}{m.available === false ? ' (indisponible)' : ''}</option>)}
    </select>
    <button type="button" className="btn small" aria-expanded={manual} onClick={() => setManual(!manual)}>
      {manual ? 'Masquer la saisie manuelle' : 'Saisir un autre identifiant'}
    </button>
    {manual && <input className="input" aria-label={`${label} : identifiant manuel`} value={value} placeholder={defaultLabel} onChange={(e) => onChange(e.target.value)} />}
  </div>;
}
