import { Fragment, useEffect, useState } from 'react';
import { useShallow } from 'zustand/react/shallow';
import {
  Wrench, CalendarClock, Sparkles, Layers, History, Play, Pause, Trash2, Pencil, Plus, Save, X, RefreshCw,
  CheckCircle2, XCircle, Loader2, Bot, Cpu, GitBranch, Webhook, FolderOpen
} from 'lucide-react';
import { formatDateTime, formatTime, previewText } from '../../lib/text';
import { bridge } from '../../lib/bridge';
import { jobSchedule, jobOutput } from '../../services/hermes/client';
import type { HermesJob, HermesJobDraft } from '../../services/hermes/types';
import { useChat } from '../../state/chat';
import { jobStatus, useHermes } from '../../state/hermes';
import { useSettings } from '../../state/settings';

type Tab = 'activity' | 'jobs' | 'skills' | 'sessions' | 'link';

const emptyDraft = (): HermesJobDraft => ({ name: '', schedule: 'every 1h', prompt: '', deliver: 'local' });

function ActivityTab() {
  const activity = useChat((s) => s.activity);
  const items = [...activity].reverse();
  if (items.length === 0) return <div className="empty">Aucune activité outil pour l’instant.</div>;
  return (
    <div>
      {items.map((a) => (
        <div key={a.id} className={`activity-item ${a.status}`}>
          <span className="icon">
            {a.status === 'running' ? <Loader2 size={13} className="spin" /> : a.status === 'done' ? <CheckCircle2 size={13} /> : <XCircle size={13} />}
          </span>
          <div>
            <div className="name">{a.kind === 'subagent' ? <><Bot size={11} /> </> : null}{a.name}</div>
            {a.detail && <div className="detail">{previewText(a.detail, 220)}</div>}
            {a.output && <div className="detail muted">{previewText(a.output, 220)}</div>}
          </div>
          <span className="time">{formatTime(a.startedAt)}{a.endedAt ? ` · ${((a.endedAt - a.startedAt) / 1000).toFixed(1)}s` : ''}</span>
        </div>
      ))}
    </div>
  );
}

function JobsTab() {
  const jobs = useHermes((s) => s.jobs);
  const busy = useHermes((s) => s.busy);
  const lastSyncAt = useHermes((s) => s.lastSyncAt);
  const refreshJobs = useHermes((s) => s.refreshJobs);
  const createJob = useHermes((s) => s.createJob);
  const updateJob = useHermes((s) => s.updateJob);
  const jobAction = useHermes((s) => s.jobAction);
  const setError = useChat((s) => s.setError);
  const [draft, setDraft] = useState<HermesJobDraft>(emptyDraft);
  const [editing, setEditing] = useState<string | null>(null);
  const [showEditor, setShowEditor] = useState(false);

  const run = async (task: Promise<void>) => {
    try {
      await task;
    } catch (err) {
      setError(`Cron Hermes : ${(err as Error).message}`);
    }
  };

  const startEdit = (job: HermesJob) => {
    setEditing(job.id);
    setDraft({ name: job.name ?? job.id, schedule: jobSchedule(job), prompt: job.prompt ?? '', deliver: job.deliver ?? 'local' });
    setShowEditor(true);
  };
  const save = async () => {
    if (editing) await run(updateJob(editing, draft));
    else await run(createJob(draft));
    setEditing(null);
    setDraft(emptyDraft());
    setShowEditor(false);
  };
  const valid = draft.name.trim() && draft.schedule.trim() && draft.prompt.trim();

  return (
    <div>
      <div className="row" style={{ marginBottom: 10, justifyContent: 'space-between' }}>
        <span className="muted mono" style={{ fontSize: 11 }}>{lastSyncAt ? `sync ${formatTime(lastSyncAt)}` : 'non synchronisé'}</span>
        <span className="row">
          <button className="icon-btn" title="Synchroniser" onClick={() => void run(refreshJobs())}><RefreshCw size={14} className={busy ? 'spin' : undefined} /></button>
          <button className="btn small" onClick={() => { setEditing(null); setDraft(emptyDraft()); setShowEditor((v) => !v); }}><Plus size={13} /> Cron</button>
        </span>
      </div>
      {showEditor && (
        <div className="job-editor">
          <input className="input" placeholder="Nom de la mission" value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} />
          <input className="input" placeholder="every 1h · 0 9 * * MON-FRI · in 30m · every monday 9am" value={draft.schedule} onChange={(e) => setDraft({ ...draft, schedule: e.target.value })} />
          <textarea className="textarea" placeholder="Instruction à exécuter par Hermes" value={draft.prompt} onChange={(e) => setDraft({ ...draft, prompt: e.target.value })} />
          <input className="input" placeholder="deliver : local · origin · telegram · all" value={draft.deliver ?? ''} onChange={(e) => setDraft({ ...draft, deliver: e.target.value })} />
          <div className="row">
            <button className="btn ghost small" onClick={() => { setShowEditor(false); setEditing(null); }}><X size={13} /> Annuler</button>
            <button className="btn primary small" disabled={!valid || busy} onClick={() => void save()}><Save size={13} /> {editing ? 'Mettre à jour' : 'Créer'}</button>
          </div>
        </div>
      )}
      {jobs.length === 0 ? (
        <div className="empty">Aucun cron Hermes. Créez une mission planifiée en langage naturel.</div>
      ) : (
        <div className="list">
          {jobs.map((job) => {
            const status = jobStatus(job).toLowerCase();
            const paused = status === 'paused' || job.enabled === false;
            const output = jobOutput(job);
            return (
              <div key={job.id} className="row-item">
                <div className="main">
                  <div className="row wrap" style={{ gap: 6 }}>
                    <span className="name">{job.name || job.id}</span>
                    <span className={`status-pill ${status}`}>{status}</span>
                    {job.last_status && <span className={`status-pill ${String(job.last_status).toLowerCase()}`}>{String(job.last_status)}</span>}
                  </div>
                  <span className="meta">{jobSchedule(job)} · prochain {formatDateTime(job.next_run_at)}</span>
                  {job.prompt && <span className="desc">{previewText(job.prompt, 140)}</span>}
                  {output && <span className="meta">↳ {previewText(output, 120)}</span>}
                </div>
                <div className="actions">
                  <button className="icon-btn" title="Exécuter maintenant" onClick={() => void run(jobAction(job.id, 'run'))}><Play size={13} /></button>
                  <button className="icon-btn" title={paused ? 'Reprendre' : 'Mettre en pause'} onClick={() => void run(jobAction(job.id, paused ? 'resume' : 'pause'))}>{paused ? <Play size={13} /> : <Pause size={13} />}</button>
                  <button className="icon-btn" title="Modifier" onClick={() => startEdit(job)}><Pencil size={13} /></button>
                  <button className="icon-btn danger" title="Supprimer" onClick={() => { if (confirm(`Supprimer le cron « ${job.name || job.id} » ?`)) void run(jobAction(job.id, 'delete')); }}><Trash2 size={13} /></button>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

function HistoryList() {
  const runs = useHermes((s) => s.jobRuns);
  const markRead = useHermes((s) => s.markRunRead);
  const addMessage = useChat((s) => s.addMessage);
  if (runs.length === 0) return null;
  return (
    <>
      <div className="section-title"><History size={12} /> Résultats récents</div>
      <div className="list">
        {runs.slice(0, 20).map((r) => (
          <div
            key={r.id}
            className="row-item clickable"
            role="button"
            tabIndex={0}
            style={{ opacity: r.read ? 0.7 : 1 }}
            onKeyDown={(e) => { if (e.key === 'Enter') (e.currentTarget as HTMLDivElement).click(); }}
            onClick={() => {
              markRead(r.id);
              addMessage({ role: 'assistant', content: r.output, source: 'cron', jobName: r.jobName, status: 'done', timestamp: new Date(r.at).getTime() || Date.now() });
            }}
          >
            <div className="main">
              <div className="row wrap" style={{ gap: 6 }}>
                <span className="name">{r.jobName}</span>
                <span className={`status-pill ${r.status}`}>{r.status}</span>
              </div>
              <span className="desc">{previewText(r.output, 160)}</span>
              <span className="meta">{formatDateTime(r.at)}</span>
            </div>
          </div>
        ))}
      </div>
    </>
  );
}

function SkillsTab() {
  const skills = useHermes((s) => s.skills);
  const toolsets = useHermes((s) => s.toolsets);
  const refresh = useHermes((s) => s.refreshCatalog);
  const [filter, setFilter] = useState('');
  const q = filter.toLowerCase();
  const visibleSkills = skills.filter((s) => !q || `${s.name} ${s.description ?? ''} ${s.category ?? ''}`.toLowerCase().includes(q));
  const visibleToolsets = toolsets.filter((t) => !q || `${t.name} ${t.label ?? ''} ${t.description ?? ''} ${(t.tools ?? []).join(' ')}`.toLowerCase().includes(q));
  return (
    <div>
      <div className="row" style={{ marginBottom: 10 }}>
        <input className="input" placeholder="Filtrer les skills et toolsets…" value={filter} onChange={(e) => setFilter(e.target.value)} />
        <button className="icon-btn" title="Recharger" onClick={() => void refresh()}><RefreshCw size={14} /></button>
      </div>
      <div className="section-title"><Sparkles size={12} /> Skills ({skills.length})</div>
      {visibleSkills.length === 0 ? <div className="empty">Aucun skill exposé par ce serveur.</div> : (
        <div className="list">
          {visibleSkills.map((s) => (
            <div key={s.name} className="row-item">
              <div className="main">
                <div className="row wrap" style={{ gap: 6 }}>
                  <span className="name">{s.name}</span>
                  {s.category && <span className="status-pill">{s.category}</span>}
                </div>
                {s.description && <span className="desc">{s.description}</span>}
              </div>
            </div>
          ))}
        </div>
      )}
      <div className="section-title"><Layers size={12} /> Toolsets ({toolsets.length})</div>
      {visibleToolsets.length === 0 ? <div className="empty">Aucun toolset listé.</div> : (
        <div className="list">
          {visibleToolsets.map((t) => (
            <div key={t.name} className="row-item">
              <div className="main">
                <div className="row wrap" style={{ gap: 6 }}>
                  <span className="name">{t.label || t.name}</span>
                  {t.enabled !== undefined && <span className={`status-pill ${t.enabled ? 'active' : 'paused'}`}>{t.enabled ? 'actif' : 'inactif'}</span>}
                  {t.configured === false && <span className="status-pill error">non configuré</span>}
                </div>
                {t.description && <span className="desc">{t.description}</span>}
                {t.tools && t.tools.length > 0 && <span className="meta">{t.tools.slice(0, 12).join(' · ')}{t.tools.length > 12 ? ` · +${t.tools.length - 12}` : ''}</span>}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function SessionsTab() {
  const sessions = useHermes((s) => s.sessions);
  const refresh = useHermes((s) => s.refreshSessions);
  const client = useHermes((s) => s.client);
  const transport = useHermes((s) => s.transport);
  const sessionId = useSettings((s) => s.settings.hermesSessionId);
  const setSessionId = useSettings((s) => s.setHermesSessionId);
  const chat = useChat.getState();

  const activeId = sessionId.replace(/^hs:/, '');
  const load = async (id: string) => {
    try {
      const messages = await client().sessionMessages(id);
      chat.clear();
      for (const m of messages.slice(-60)) {
        if (!m.content) continue;
        chat.addMessage({ role: m.role === 'user' ? 'user' : 'assistant', content: String(m.content), status: 'done', source: 'hermes', timestamp: m.timestamp ? new Date(m.timestamp).getTime() : Date.now() });
      }
      setSessionId(transport === 'sessions' ? `hs:${id}` : id);
    } catch (err) {
      chat.setError(`Session : ${(err as Error).message}`);
    }
  };
  const fresh = () => {
    chat.clear();
    setSessionId(`eveflow-${Date.now().toString(36)}`);
  };

  return (
    <div>
      <div className="row" style={{ marginBottom: 10, justifyContent: 'space-between' }}>
        <span className="muted mono" style={{ fontSize: 11 }}>session {previewText(activeId, 28)}</span>
        <span className="row">
          <button className="icon-btn" title="Recharger" onClick={() => void refresh()}><RefreshCw size={14} /></button>
          <button className="btn small" onClick={fresh}><Plus size={13} /> Nouvelle</button>
        </span>
      </div>
      {sessions.length === 0 ? <div className="empty">Aucune session listée par Hermes.</div> : (
        <div className="list">
          {sessions.map((s) => (
            <div key={s.id} className="row-item clickable" role="button" tabIndex={0} style={s.id === activeId ? { borderColor: 'var(--accent)' } : undefined} onClick={() => void load(s.id)} onKeyDown={(e) => { if (e.key === 'Enter') void load(s.id); }}>
              <div className="main">
                <span className="name">{s.title || s.id}</span>
                <span className="meta">{[s.platform ?? s.source, s.message_count ? `${s.message_count} msg` : null, formatDateTime(s.updated_at ?? s.created_at)].filter(Boolean).join(' · ')}</span>
              </div>
              <div className="actions">
                <button className="icon-btn" title="Bifurquer (fork)" onClick={(e) => { e.stopPropagation(); client().forkSession(s.id).then(() => refresh()).catch((err: Error) => chat.setError(err.message)); }}><GitBranch size={13} /></button>
                <button className="icon-btn danger" title="Supprimer" onClick={(e) => { e.stopPropagation(); if (confirm('Supprimer cette session Hermes ?')) client().deleteSession(s.id).then(() => refresh()).catch((err: Error) => chat.setError(err.message)); }}><Trash2 size={13} /></button>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function LinkTab() {
  const { link, linkDetail, health, capabilities, transport, models, webhook } = useHermes(
    useShallow((s) => ({ link: s.link, linkDetail: s.linkDetail, health: s.health, capabilities: s.capabilities, transport: s.transport, models: s.models, webhook: s.webhook }))
  );
  const connect = useHermes((s) => s.connect);
  const hermes = useSettings((s) => s.settings.hermes);
  const [info, setInfo] = useState<{ sharedDir: string; logPath: string; version: string } | null>(null);
  useEffect(() => {
    bridge()?.system.appInfo().then(setInfo).catch(() => undefined);
  }, []);
  const checks = (health?.readiness as { checks?: Record<string, unknown> } | undefined)?.checks ?? {};
  const features = capabilities?.features ?? {};
  return (
    <div>
      <div className="section-title"><Cpu size={12} /> Liaison Hermes</div>
      <dl className="kv">
        <dt>État</dt><dd><span className={`status-pill ${link}`}>{link}</span> {linkDetail}</dd>
        <dt>URL</dt><dd>{hermes.url || '—'}</dd>
        <dt>Transport</dt><dd>{transport}{hermes.transport === 'auto' ? ' (auto)' : ''}</dd>
        <dt>Modèle</dt><dd>{hermes.model || String(capabilities?.model ?? '—')}</dd>
        {capabilities?.version ? <><dt>Version</dt><dd>{String(capabilities.version)}</dd></> : null}
        <dt>Modèles</dt><dd>{models.length ? models.map((m) => m.id).slice(0, 6).join(', ') + (models.length > 6 ? '…' : '') : '—'}</dd>
      </dl>
      <div className="row" style={{ marginTop: 8 }}>
        <button className="btn small" onClick={() => void connect()}><RefreshCw size={13} /> Reconnecter</button>
      </div>
      {Object.keys(features).length > 0 && (
        <>
          <div className="section-title"><Layers size={12} /> Capacités</div>
          <div className="row wrap" style={{ gap: 6 }}>
            {Object.entries(features).map(([k, v]) => (
              <span key={k} className={`status-pill ${v ? 'ok' : ''}`}>{k}{typeof v === 'string' ? `: ${v}` : ''}</span>
            ))}
          </div>
        </>
      )}
      {Object.keys(checks).length > 0 && (
        <>
          <div className="section-title"><CheckCircle2 size={12} /> Santé</div>
          <dl className="kv">
            {Object.entries(checks).map(([k, v]) => (
              <Fragment key={k}><dt>{k}</dt><dd>{typeof v === 'object' ? JSON.stringify(v) : String(v)}</dd></Fragment>
            ))}
          </dl>
        </>
      )}
      <div className="section-title"><Webhook size={12} /> Webhook entrant</div>
      <dl className="kv">
        <dt>État</dt><dd><span className={`status-pill ${webhook?.listening ? 'online' : 'offline'}`}>{webhook?.listening ? 'à l’écoute' : 'inactif'}</span> {webhook?.error}</dd>
        <dt>Endpoint</dt><dd>POST http://&lt;cette-machine&gt;:{webhook?.port ?? 7842}{webhook?.path ?? '/eveflow/hook'}</dd>
        <dt>Secret</dt><dd>{webhook?.secretConfigured ? 'requis (X-EveFlow-Secret)' : 'aucun'}</dd>
      </dl>
      {info && (
        <>
          <div className="section-title"><FolderOpen size={12} /> Application</div>
          <dl className="kv">
            <dt>Version</dt><dd>{info.version}</dd>
            <dt>Partage</dt><dd><a href="#" onClick={(e) => { e.preventDefault(); bridge()?.files.openPath(info.sharedDir); }}>{info.sharedDir}</a></dd>
            <dt>Journal</dt><dd><a href="#" onClick={(e) => { e.preventDefault(); bridge()?.files.showInFolder(info.logPath); }}>{info.logPath}</a></dd>
          </dl>
        </>
      )}
    </div>
  );
}

export function OpsPanel() {
  const [tab, setTab] = useState<Tab>('activity');
  const running = useChat((s) => s.activity.filter((a) => a.status === 'running').length);
  const unread = useHermes((s) => s.jobRuns.filter((r) => !r.read).length);
  const link = useHermes((s) => s.link);

  const tabs: Array<{ id: Tab; label: string; icon: React.ReactNode; badge?: number }> = [
    { id: 'activity', label: 'Outils', icon: <Wrench size={13} />, badge: running },
    { id: 'jobs', label: 'Crons', icon: <CalendarClock size={13} />, badge: unread },
    { id: 'skills', label: 'Skills', icon: <Sparkles size={13} /> },
    { id: 'sessions', label: 'Sessions', icon: <History size={13} /> },
    { id: 'link', label: 'Liaison', icon: <Cpu size={13} /> }
  ];

  return (
    <section className="panel bracket ops-panel">
      <header className="panel-head">
        <span className={`led ${link === 'online' ? '' : link === 'offline' ? 'error' : link === 'unknown' ? 'off' : 'warn'}`} />
        <span>Hermes Ops</span>
      </header>
      <div className="tabs">
        {tabs.map((t) => (
          <button key={t.id} className={`tab${tab === t.id ? ' active' : ''}`} onClick={() => setTab(t.id)}>
            {t.icon} {t.label}
            {t.badge ? <span className="badge">{t.badge}</span> : null}
          </button>
        ))}
      </div>
      <div className="panel-body">
        {tab === 'activity' && <ActivityTab />}
        {tab === 'jobs' && (<><JobsTab /><HistoryList /></>)}
        {tab === 'skills' && <SkillsTab />}
        {tab === 'sessions' && <SessionsTab />}
        {tab === 'link' && <LinkTab />}
      </div>
    </section>
  );
}
