import { useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { Cloud, Folder, House, LockKeyhole, LogOut, Menu, ShieldCheck, Trash2, X } from 'lucide-react';
import { api } from './api';
import type { StorageUsage } from './api';
import { Brand } from './Brand';
import { formatSize } from './formatSize';
import { storageOverview } from './storageOverview';

export function Workspace({ children, filesNavigation, storage, page, usage, trashActive, onSignOut }: {
  children: ReactNode;
  filesNavigation?: ReactNode;
  storage?: ReactNode;
  page?: 'connections' | 'account';
  usage?: StorageUsage | null;
  trashActive?: boolean;
  onSignOut: () => void;
}) {
  const drawer = useRef<HTMLDialogElement>(null);
  const [open, setOpen] = useState(false);
  const [hash, setHash] = useState(window.location.hash);
  const [sidebarUsage, setSidebarUsage] = useState<StorageUsage | null>(null);
  const showUsage = usage === undefined;
  useEffect(() => {
    if (!showUsage) return;
    const controller = new AbortController();
    void api<StorageUsage>('/storage/usage', { signal: controller.signal })
      .then((result) => { if (!controller.signal.aborted) setSidebarUsage(result); })
      .catch(() => undefined);
    return () => controller.abort();
  }, [showUsage]);
  useEffect(() => {
    const viewport = window.matchMedia('(max-width: 760px)');
    const closeOnDesktop = () => { if (!viewport.matches && drawer.current?.open) drawer.current.close(); };
    const followHash = () => {
      setHash(window.location.hash);
      if (window.location.hash === '#security') document.getElementById('security')?.scrollIntoView();
    };
    followHash();
    viewport.addEventListener('change', closeOnDesktop);
    window.addEventListener('hashchange', followHash);
    return () => {
      viewport.removeEventListener('change', closeOnDesktop);
      window.removeEventListener('hashchange', followHash);
    };
  }, []);
  const data = usage ?? sidebarUsage;
  const summary = data ? storageOverview(data.cloud) : undefined;
  const current = page === 'account' && hash === '#security' ? 'security' : page;
  const dashboard = !filesNavigation && !page;
  const menu = <>
    <Brand />
    <nav aria-label="Drive navigation" onClick={(event) => {
      if ((event.target as Element).closest('a, button') && drawer.current?.open) drawer.current.close();
    }}>
      <a className={dashboard ? 'nav active' : 'nav'} href="/" aria-current={dashboard ? 'page' : undefined}>
        <House size={19} /> Dashboard
      </a>
      {filesNavigation ?? <a className="nav" href="/drive"><Folder size={19} /> My Files</a>}
      <a href="/connections" className={current === 'connections' ? 'nav active' : 'nav'}
        aria-current={current === 'connections' ? 'page' : undefined}><Cloud size={19} /> Account Connections</a>
      <a href="/account" className={current === 'account' ? 'nav active' : 'nav'}
        aria-current={current === 'account' ? 'page' : undefined}><ShieldCheck size={19} /> Login Management</a>
      <a href="/account#security" className={current === 'security' ? 'nav active' : 'nav'}
        aria-current={current === 'security' ? 'location' : undefined}><LockKeyhole size={19} /> Security</a>
      <a href="/drive?view=trash" className={trashActive ? 'nav active' : 'nav'}
        aria-current={trashActive ? 'page' : undefined}><Trash2 size={19} /> Recycle Bin</a>
    </nav>
    <div className="sidebar-bottom">
      {summary && <div className="sidebar-capacity">
        <div><Cloud size={22} aria-hidden="true" /><span><strong>Overall Storage</strong>
          <small>{summary.reported ? formatSize(summary.used) + ' / ' + formatSize(summary.total) : 'Capacity unavailable'}</small></span></div>
        {summary.percentage !== null && <div className="sidebar-capacity-meter">
          <progress aria-label="Overall storage used" max={100} value={Math.min(100, summary.percentage)} />
          <small>{summary.percentage.toFixed(1)}%</small>
        </div>}
      </div>}
      {storage && <details className="sidebar-status"><summary>Storage connections</summary>{storage}</details>}
      <button className="nav sign-out" onClick={onSignOut}><LogOut size={19} /> Sign out</button>
    </div>
  </>;

  return <div className="workspace">
    <header className="mobile-bar">
      <Brand />
      <button className="icon" aria-label="Open navigation" aria-controls="navigation-drawer" aria-expanded={open}
        onClick={() => { drawer.current?.showModal(); setOpen(true); }}><Menu size={23} /></button>
    </header>
    <aside className="sidebar desktop-sidebar">{menu}</aside>
    <dialog ref={drawer} id="navigation-drawer" className="navigation-drawer" aria-label="Navigation" onClose={() => setOpen(false)}>
      <aside className="sidebar mobile-sidebar">
        <button className="icon drawer-close" aria-label="Close navigation" onClick={() => drawer.current?.close()}><X size={22} /></button>
        {menu}
      </aside>
    </dialog>
    {children}
  </div>;
}
