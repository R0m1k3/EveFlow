import { Activity } from 'lucide-react';
import { useMetrics } from '../../hooks/useMetrics';
import { formatDuration } from '../../lib/text';

function Gauge({ value, max, label, display, warn }: { value: number; max: number; label: string; display: string; warn?: number }) {
  const ratio = Math.max(0, Math.min(1, value / max));
  const r = 24;
  const c = 2 * Math.PI * r;
  const arc = c * 0.75;
  const color = warn !== undefined && value >= warn ? 'var(--danger)' : 'var(--accent)';
  return (
    <div className="gauge">
      <svg viewBox="0 0 62 62">
        <circle cx="31" cy="31" r={r} fill="none" stroke="rgba(var(--accent-rgb),0.15)" strokeWidth="4" strokeDasharray={`${arc} ${c}`} transform="rotate(135 31 31)" strokeLinecap="round" />
        <circle cx="31" cy="31" r={r} fill="none" stroke={color} strokeWidth="4" strokeDasharray={`${arc * ratio} ${c}`} transform="rotate(135 31 31)" strokeLinecap="round" style={{ transition: 'stroke-dasharray 600ms ease', filter: `drop-shadow(0 0 4px ${color})` }} />
        <text x="31" y="35" textAnchor="middle" fontSize="11" fontFamily="var(--font-mono)" fill="var(--ink-0)">{display}</text>
      </svg>
      <span className="label">{label}</span>
    </div>
  );
}

export function Telemetry() {
  const m = useMetrics(true);
  return (
    <section className="panel bracket">
      <header className="panel-head">
        <Activity size={14} />
        <span>Système</span>
        <span className="spacer" />
        <span className="chip">{m.hostname}</span>
      </header>
      <div className="telemetry">
        <Gauge value={m.cpuLoad} max={100} label="CPU" display={`${Math.round(m.cpuLoad)}%`} warn={90} />
        <Gauge value={m.memUsedPct} max={100} label="RAM" display={`${Math.round(m.memUsedPct)}%`} warn={92} />
        <Gauge value={m.fps} max={60} label="FPS" display={`${m.fps}`} />
        <Gauge value={m.cpuFreqMhz} max={5500} label="GHz" display={m.cpuFreqMhz ? (m.cpuFreqMhz / 1000).toFixed(1) : '—'} />
      </div>
      <div className="telemetry-foot">
        <span>{m.cpuCores} cœurs{m.cpuModel ? ` · ${m.cpuModel.replace(/\(R\)|\(TM\)|CPU|@.*$/g, '').trim()}` : ''}</span>
        <span>{m.memTotalGb ? `${m.memTotalGb} Go` : ''}{m.uptimeSec ? ` · up ${formatDuration(m.uptimeSec)}` : ''}</span>
      </div>
    </section>
  );
}
