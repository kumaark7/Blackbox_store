import { useEffect, useState } from 'react';
import { api, cloudNames, labels } from './api';
import type { Importance, StorageUsage } from './api';
import { formatSize } from './formatSize';
import { Workspace } from './Workspace';

const number = new Intl.NumberFormat();

function arc(radius: number, from = 0, to = 1) {
  const point = (part: number) => {
    const angle = part * Math.PI;
    return `${140 - radius * Math.cos(angle)} ${135 - radius * Math.sin(angle)}`;
  };
  return `M ${point(from)} A ${radius} ${radius} 0 0 1 ${point(to)}`;
}

function DashboardChart({ cloud }: { cloud: StorageUsage['cloud'] }) {
  const [hovered, setHovered] = useState<Importance | null>(null);
  const [selected, setSelected] = useState<Importance | null>(null);
  const capacityAccounts = cloud.accounts.filter(({ id, status }) => id !== 'telegram' && (status === 'connected' || status === 'retrying'));
  const quotas = capacityAccounts.flatMap(({ quota }) => quota && quota.totalBytes !== null
    ? [{ used: quota.usedBytes, total: quota.totalBytes }] : []);
  const used = quotas.reduce((sum, quota) => sum + quota.used, 0);
  const total = quotas.reduce((sum, quota) => sum + quota.total, 0);
  const usage = total > 0 ? Math.min(used / total, 1) : Number(used > 0);
  const files = cloud.priorities.reduce((sum, row) => sum + row.files, 0);
  const active = cloud.priorities.find((row) => row.importance === (hovered ?? selected));
  let previous = 0;
  const segments = cloud.priorities.map((row) => {
    const start = previous;
    previous += row.files;
    return { ...row, start, end: previous };
  });
  const toggle = (importance: Importance) => setSelected((current) => current === importance ? null : importance);

  return <div className="dashboard-overview">
    <div className="dashboard-capacity">
      <h3>Cloud capacity</h3>
      <div className="dashboard-chart">
        <svg viewBox="0 0 280 146" aria-hidden="true">
          <path className="quota-track" d={arc(118)} strokeWidth="15" />
          {usage > 0 && <path className="quota-used" d={arc(118, 0, usage)} strokeWidth="15" />}
          <path className="quota-track" d={arc(96)} strokeWidth="14" />
          {segments.filter((row) => row.files > 0).map(({ importance, start, end }) =>
            <path key={importance} className="priority-arc" data-priority={importance}
              data-active={active?.importance === importance} d={arc(96, start / files, end / files)} strokeWidth="14"
              onPointerEnter={() => setHovered(importance)} onPointerLeave={() => setHovered(null)} onClick={() => toggle(importance)} />)}
        </svg>
        <div className="dashboard-chart-value" role="status">
          <strong>{active ? number.format(active.files) + (active.files === 1 ? ' file' : ' files')
            : quotas.length ? formatSize(used) + ' used' : 'Quota unavailable'}</strong>
          <span>{active ? labels[active.importance] + ' · ' + formatSize(active.bytes) : quotas.length ? 'of ' + formatSize(total) : 'Connected account totals'}</span>
        </div>
      </div>
      {quotas.length > 0 && <p className="muted dashboard-coverage">
        Capacity from {quotas.length} of {capacityAccounts.length} connected storage {capacityAccounts.length === 1 ? 'account' : 'accounts'}
      </p>}
    </div>
    <section className="dashboard-priorities" aria-label="Cloud files by priority">
      <h3>Cloud files by priority</h3>
      <ul>
        {cloud.priorities.map(({ importance, files, bytes }) => <li key={importance}>
          <button type="button" className="dashboard-priority" data-priority={importance} aria-pressed={selected === importance}
            data-active={active?.importance === importance} onPointerEnter={() => setHovered(importance)}
            onPointerLeave={() => setHovered(null)} onFocus={() => setHovered(importance)}
            onBlur={() => setHovered(null)} onClick={() => toggle(importance)}>
            <span className="priority-swatch" aria-hidden="true" />
            <span>{labels[importance]}<small>{formatSize(bytes)}</small></span>
            <strong>{number.format(files)} {files === 1 ? 'file' : 'files'}</strong>
          </button>
        </li>)}
      </ul>
    </section>
  </div>;
}

function StorageDashboard({ usage }: { usage: StorageUsage }) {
  return <div className="storage-dashboard">
    <DashboardChart cloud={usage.cloud} />
    <section className="dashboard-accounts" aria-label="Cloud accounts">
      <h3>Cloud accounts</h3>
      {usage.cloud.accounts.length === 0 ? <p className="muted">No cloud accounts connected.</p> :
        <ul>{usage.cloud.accounts.map(({ id, status, tracked, quota }) => <li key={id}>
          <div><strong>{cloudNames[id]}</strong><small>
            {number.format(tracked.files)} {tracked.files === 1 ? 'copy' : 'copies'} · {formatSize(tracked.bytes)} tracked
          </small></div>
          <div className="dashboard-account-quota">
            {id === 'telegram' ? <small>Excluded from cloud capacity</small> : quota ? <><strong>{formatSize(quota.usedBytes)} used</strong>
              <small>{quota.totalBytes === null ? 'Total quota unavailable' : 'of ' + formatSize(quota.totalBytes)}</small></>
              : <small>{status === 'reconnect' ? 'Reconnect account' : 'Account quota unavailable'}</small>}
          </div>
        </li>)}</ul>}
    </section>
    <section className="dashboard-local" aria-label="Local storage">
      <h3>Local storage</h3>
      <dl className="storage-usage">
        <div><dt>Blackbox Store data</dt><dd>{formatSize(usage.appBytes)}</dd></div>
        <div><dt>Recycle Bin</dt><dd>{formatSize(usage.trashBytes)}</dd></div>
        <div><dt>Free on server disk</dt><dd>{usage.disk ? <>
          {formatSize(usage.disk.availableBytes)} <small>of {formatSize(usage.disk.totalBytes)}</small>
        </> : 'Unavailable'}</dd></div>
      </dl>
    </section>
  </div>;
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
        if (!controller.signal.aborted) {
          setUsage(result);
          setError('');
        }
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
    try {
      await api('/auth/logout', { method: 'POST' });
      onLogout();
    } catch (failure) {
      setLogoutError((failure as Error).message);
    }
  }

  return <Workspace onSignOut={() => void signOut()}>
    <main className="main">
      <div className="content dashboard-page">
        <h1>Storage dashboard</h1>
        {logoutError && <p className="error" role="alert">{logoutError}</p>}
        {error && <div className="dashboard-load-error">
          <p className="error" role="alert">{error}</p>
          <button onClick={() => { setError(''); setAttempt((current) => current + 1); }}>Try again</button>
        </div>}
        {usage ? <StorageDashboard usage={usage} /> : !error && <p role="status">Checking storage usage</p>}
      </div>
    </main>
  </Workspace>;
}
