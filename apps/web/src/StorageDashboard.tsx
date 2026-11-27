import { useEffect, useState } from 'react';
import {
  ArrowUpFromLine, ChartPie, Cloud, Crown, Database, Ellipsis, FolderPlus, Layers3,
  LayoutGrid, Link2, Plus, Search, Settings, ShieldCheck, Star, Zap,
} from 'lucide-react';
import { api, cloudNames, labels } from './api';
import type { CloudProvider, Importance, StorageUsage } from './api';
import { formatSize } from './formatSize';
import { storageOverview } from './storageOverview';
import { Workspace } from './Workspace';
import googleLogo from './providers/google-drive.svg?no-inline';
import megaLogo from './providers/mega.svg?no-inline';
import teraboxLogo from './providers/terabox.svg?no-inline';
import telegramLogo from './providers/telegram.svg?no-inline';

const number = new Intl.NumberFormat();
const priorityIcons = { 'highly-important': Crown, important: Star, backup: ShieldCheck };
const priorityText = { 'highly-important': 'Critical files', important: 'General files', backup: 'Redundant copies' };
const statusLabels = { off: 'Disconnected', reconnect: 'Reconnect required', retrying: 'Sync retrying', connected: 'Connected' };
const accountRoute = { 'google-drive': 'googleDrive', mega: 'mega', terabox: 'terabox', telegram: 'telegram' };
const actions = [
  { title: 'Upload Files', description: 'Add files to your cloud', icon: ArrowUpFromLine, tone: 'purple', url: '/drive?action=upload' },
  { title: 'New Folder', description: 'Organize your files', icon: FolderPlus, tone: 'blue', url: '/drive?action=folder' },
  { title: 'Connect Account', description: 'Add a cloud provider', icon: Link2, tone: 'teal', url: '/connections' },
  { title: 'View Files', description: 'Browse your files and folders', icon: LayoutGrid, tone: 'gold', url: '/drive' },
];

function Capacity({ overview }: { overview: ReturnType<typeof storageOverview> }) {
  const known = overview.reported > 0;
  const percentage = overview.percentage;
  const fill = Math.min(100, percentage ?? 0);
  const arc = 'M 28 151 A 152 144 0 0 1 332 151';
  return <section className="glass-panel dashboard-capacity" aria-label="Cloud capacity">
    <div className="card-heading"><h2><Layers3 aria-hidden="true" /> Cloud Capacity</h2>
      <span className="dashboard-badge" title={overview.reported + ' of ' + overview.eligible + ' storage accounts report total capacity'}>
        {overview.accounts.length} connected
      </span>
    </div>
    <div className="dashboard-chart">
      <svg viewBox="0 0 360 166" aria-hidden="true">
        <defs><linearGradient id="capacity-gradient" x1="0" y1="0" x2="360" y2="0" gradientUnits="userSpaceOnUse">
          <stop stopColor="#38D9F5" /><stop offset=".4" stopColor="#4F8CFF" /><stop offset=".76" stopColor="#8B5CF6" /><stop offset="1" stopColor="#D946EF" />
        </linearGradient></defs>
        <path className="quota-track" d={arc} pathLength="100" />
        {fill > 0 && <path className="quota-used" d={arc} pathLength="100" strokeDasharray={fill + ' 100'} />}
      </svg>
      <div className="dashboard-chart-value">
        <Cloud size={27} aria-hidden="true" />
        <strong>{known ? <><span>{formatSize(overview.used)}</span> Used</> : 'Quota unavailable'}</strong>
        <small>{known ? 'of ' + formatSize(overview.total) : 'Connected account capacity'}</small>
      </div>
    </div>
    <div className="capacity-metrics">
      <div><Database aria-hidden="true" /><span><strong>{known ? formatSize(overview.free) : 'Unavailable'}</strong><small>Free Space</small></span></div>
      <div><Layers3 aria-hidden="true" /><span><strong>{known ? formatSize(overview.total) : 'Unavailable'}</strong><small>Total Capacity</small></span></div>
      <div><ChartPie aria-hidden="true" /><span><strong>{percentage === null ? 'Unavailable' : percentage.toFixed(1) + '%'}</strong><small>Used</small></span></div>
    </div>
    {overview.reported > 0 && overview.reported < overview.eligible && <p className="dashboard-coverage">
      Capacity from {overview.reported} of {overview.eligible} connected storage accounts
    </p>}
  </section>;
}

function PriorityBreakdown({ usage }: { usage: StorageUsage }) {
  const active = storageOverview(usage.cloud).accounts;
  const configured = (id: CloudProvider) => active.some((account) => account.id === id);
  const targets: Record<Importance, string> = {
    'highly-important': 'Google Drive',
    important: 'MEGA',
    backup: usage.cloudOnly ? configured('terabox') ? 'TeraBox' : configured('telegram') ? 'Telegram' : 'TeraBox / Telegram'
      : (['terabox', 'telegram'] as const).filter(configured).map((id) => cloudNames[id]).join(' / ') || 'TeraBox / Telegram',
  };
  return <section className="glass-panel dashboard-priorities" aria-label="Files by priority">
    <div className="card-heading"><h2><Layers3 aria-hidden="true" /> Files by Priority</h2></div>
    <ul>{usage.cloud.priorities.map(({ importance, files, bytes }) => {
      const Icon = priorityIcons[importance];
      return <li key={importance}>
        <a className="dashboard-priority" data-priority={importance} href={'/drive?priority=' + importance}>
          <Icon size={24} aria-hidden="true" />
          <span><strong>{labels[importance]}</strong><small>{priorityText[importance]} ({targets[importance]})</small></span>
          <span className="priority-totals"><strong>{formatSize(bytes)}</strong>
            <small>{number.format(files)} {files === 1 ? 'file' : 'files'}</small></span>
        </a>
      </li>;
    })}</ul>
    <p className="tracked-caption">Files tracked by Blackbox</p>
  </section>;
}

const providerLogos: Record<CloudProvider, string> = {
  'google-drive': googleLogo,
  mega: megaLogo,
  terabox: teraboxLogo,
  telegram: telegramLogo,
};

function ConnectedAccounts({ accounts }: { accounts: ReturnType<typeof storageOverview>['accounts'] }) {
  return <section aria-labelledby="connected-accounts-title">
    <div className="section-heading">
      <h2 id="connected-accounts-title"><Cloud aria-hidden="true" /> Connected Cloud Accounts</h2>
      <a href="/connections" className="primary"><Plus size={17} aria-hidden="true" /> Connect Account</a>
    </div>
    {accounts.length ? <ul className="dashboard-accounts">
      {accounts.map(({ id, tracked, quota, status }) => {
        const percent = id !== 'telegram' && quota?.totalBytes && quota.totalBytes > 0 ? quota.usedBytes / quota.totalBytes * 100 : null;
        const settings = '/connections?provider=' + accountRoute[id];
        return <li key={id} className="glass-panel provider-card" data-provider={id}>
          <img className="provider-logo" src={providerLogos[id]} alt="" width={42} height={42} loading="lazy" />
          <div className="provider-details">
            <div className="provider-heading"><h3>{cloudNames[id]}</h3><span className="provider-status" data-status={status}>
              <i aria-hidden="true" /> {statusLabels[status]}</span></div>
            <small>{number.format(tracked.files)} {tracked.files === 1 ? 'copy' : 'copies'} · {formatSize(tracked.bytes)} tracked</small>
          </div>
          <details className="entry-actions" name="dashboard-account-actions">
            <summary className="icon" aria-label={cloudNames[id] + ' actions'}><Ellipsis size={21} /></summary>
            <div className="menu">
              <a href={settings}>Manage connection</a>
              {id === 'google-drive' && <a href="/drive?cloud=google">Browse Google Drive</a>}
              {id === 'mega' && <a href="/drive?cloud=mega">Browse MEGA</a>}
            </div>
          </details>
          <div className="provider-usage">
            <small>{id === 'telegram' ? 'Excluded from cloud capacity' : quota
              ? <><strong>{formatSize(quota.usedBytes)} used</strong> {quota.totalBytes === null ? '· total unavailable' : 'of ' + formatSize(quota.totalBytes)}</>
              : 'Account quota unavailable'}</small>
            {percent !== null && <div className="provider-meter">
              <progress aria-label={cloudNames[id] + ' storage used'} max={100} value={Math.min(100, percent)} />
              <small>{percent.toFixed(1)}%</small>
            </div>}
          </div>
        </li>;
      })}
    </ul> : <div className="glass-panel accounts-empty"><Cloud aria-hidden="true" /><p>No cloud accounts connected.</p></div>}
  </section>;
}

function QuickActions() {
  return <section aria-labelledby="quick-actions-title">
    <div className="section-heading"><h2 id="quick-actions-title"><Zap aria-hidden="true" /> Quick Actions</h2></div>
    <div className="quick-actions">{actions.map(({ title, description, icon: Icon, tone, url }) =>
      <a className="quick-action glass-panel" data-tone={tone} key={title} href={url}>
        <span className="quick-icon"><Icon size={25} aria-hidden="true" /></span>
        <span><strong>{title}</strong><small>{description}</small></span>
      </a>)}</div>
  </section>;
}

export function DashboardHome({ onLogout }: { onLogout: () => void }) {
  const [usage, setUsage] = useState<StorageUsage | null>(null);
  const [error, setError] = useState('');
  const [logoutError, setLogoutError] = useState('');
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    let loading = false;
    async function refresh() {
      if (loading || controller.signal.aborted) return;
      loading = true;
      try {
        const result = await api<StorageUsage>('/storage/usage', { signal: controller.signal });
        if (!controller.signal.aborted) { setUsage(result); setError(''); }
      } catch (failure) {
        if (!controller.signal.aborted) setError((failure as Error).message);
      } finally { loading = false; }
    }
    void refresh();
    const focused = () => { if (!document.hidden) void refresh(); };
    const timer = window.setInterval(focused, 30_000);
    window.addEventListener('focus', focused);
    return () => { controller.abort(); window.clearInterval(timer); window.removeEventListener('focus', focused); };
  }, [attempt]);

  async function signOut() {
    try { await api('/auth/logout', { method: 'POST' }); onLogout(); }
    catch (failure) { setLogoutError((failure as Error).message); }
  }

  const overview = usage && storageOverview(usage.cloud);
  return <Workspace usage={usage} onSignOut={() => void signOut()}>
    <main className="main dashboard-main">
      <svg className="dashboard-waves" viewBox="0 0 1240 205" preserveAspectRatio="none" aria-hidden="true">
        <defs>
          <linearGradient id="wave-fill" x1=".4" x2=".6" y2="1">
            <stop stopColor="#5532be" stopOpacity=".64" /><stop offset="1" stopColor="#182554" stopOpacity="0" />
          </linearGradient>
          <linearGradient id="wave-edge">
            <stop stopColor="#4F8CFF" stopOpacity="0" /><stop offset=".3" stopColor="#4F8CFF" stopOpacity=".62" />
            <stop offset=".56" stopColor="#8B5CF6" stopOpacity=".82" /><stop offset=".79" stopColor="#8B5CF6" stopOpacity="0" />
          </linearGradient>
          <linearGradient id="wave-right" x1=".1" x2=".6" y2="1">
            <stop stopColor="#D946EF" stopOpacity=".54" /><stop offset="1" stopColor="#2a1848" stopOpacity="0" />
          </linearGradient>
        </defs>
        <path fill="url(#wave-fill)" stroke="url(#wave-edge)" strokeWidth="1.5"
          d="M0 202 C180 195 275 186 380 132 C434 105 476 42 536 34 C607 24 630 99 698 100 C767 102 800 54 842 54 L930 205 H0Z" />
        <path fill="url(#wave-right)" stroke="url(#wave-edge)" strokeWidth="1.3"
          d="M965 205 C1058 154 1078 119 1147 112 C1205 106 1224 90 1240 66 V205Z" />
      </svg>
      <div className="content dashboard-page">
      <header className="dashboard-header">
        <div><h1><span>Storage</span> Dashboard</h1><p>Manage your connected cloud storage in one place.</p></div>
        <div className="dashboard-tools">
          <form className="search" role="search" action="/drive">
            <Search size={18} aria-hidden="true" />
            <input type="search" name="q" aria-label="Search Blackbox files and folders" placeholder="Search files, folders…" maxLength={180} required />
          </form>
          <a className="header-icon" href="/account#security" aria-label="Security settings" title="Security settings"><Settings size={21} /></a>
          <a className="header-avatar" href="/account" aria-label="Owner account" title="Owner account">O</a>
        </div>
      </header>
      {logoutError && <p className="error" role="alert">{logoutError}</p>}
      {error && <div className="dashboard-load-error">
        <p className="error" role="alert">{error}</p>
        <button onClick={() => { setError(''); setAttempt((current) => current + 1); }}>Try again</button>
      </div>}
      {usage && overview ? <>
        <div className="dashboard-overview"><Capacity overview={overview} /><PriorityBreakdown usage={usage} /></div>
        <ConnectedAccounts accounts={overview.accounts} />
      </> : !error && <div className="dashboard-overview" role="status">
        <span className="sr-only">Checking storage usage</span>
        <div className="glass-panel dashboard-skeleton skeleton" aria-hidden="true" />
        <div className="glass-panel dashboard-skeleton skeleton" aria-hidden="true" />
      </div>}
      <QuickActions />
      {usage && !usage.cloudOnly && <section className="glass-panel dashboard-local" aria-label="Local storage">
        <div className="card-heading"><h2><Database aria-hidden="true" /> Local Storage</h2></div>
        <dl className="storage-usage">
          <div><dt>Blackbox Store data</dt><dd>{formatSize(usage.appBytes)}</dd></div>
          <div><dt>Recycle Bin</dt><dd>{formatSize(usage.trashBytes)}</dd></div>
          <div><dt>Free on server disk</dt><dd>{usage.disk ? formatSize(usage.disk.availableBytes) + ' of ' + formatSize(usage.disk.totalBytes) : 'Unavailable'}</dd></div>
        </dl>
      </section>}
    </div></main>
  </Workspace>;
}
