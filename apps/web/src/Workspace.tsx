import type { ReactNode } from 'react';
import { Cloud, Folder, LayoutDashboard, LockKeyhole, LogOut } from 'lucide-react';
import { Brand } from './Brand';

export function Workspace({ children, filesNavigation, storage, page, onSignOut }: {
  children: ReactNode;
  filesNavigation?: ReactNode;
  storage?: ReactNode;
  page?: 'connections' | 'account';
  onSignOut: () => void;
}) {
  return <div className="workspace">
    <aside className="sidebar">
      <Brand />
      <nav aria-label="Drive">
        <a className={filesNavigation || page ? 'nav' : 'nav active'} href="/" aria-current={filesNavigation || page ? undefined : 'page'}>
          <LayoutDashboard size={18} /> Dashboard
        </a>
        {filesNavigation ?? <a className="nav" href="/drive"><Folder size={18} /> My files</a>}
        <a href="/connections" className={page === 'connections' ? 'nav active' : 'nav'} aria-current={page === 'connections' ? 'page' : undefined}>
          <Cloud size={18} /> Account connections
        </a>
        <a href="/account" className={page === 'account' ? 'nav active' : 'nav'} aria-current={page === 'account' ? 'page' : undefined}>
          <LockKeyhole size={18} /> Login management
        </a>
      </nav>
      <div className="sidebar-bottom">
        {storage}
        <button className="nav sign-out" onClick={onSignOut}><LogOut size={17} /> Sign out</button>
      </div>
    </aside>
    {children}
  </div>;
}
