import { lazy, Suspense, useEffect, useState } from 'react';
import type { FormEvent } from 'react';
import { LockKeyhole } from 'lucide-react';
import { createRoot } from 'react-dom/client';
import { api, sessionEnded } from './api';
import type { AuthStatus } from './api';
import { Brand } from './Brand';
import { DashboardHome } from './StorageDashboard';
import './styles.css';

const FileManager = lazy(() => import('./FileManager').then((module) => ({ default: module.FileManager })));
const CloudFiles = lazy(() => import('./CloudFiles').then((module) => ({ default: module.CloudFiles })));
const AccountConnections = lazy(() => import('./AccountSettings').then((module) => ({ default: module.AccountConnections })));
const TelegramHelp = lazy(() => import('./AccountSettings').then((module) => ({ default: module.TelegramHelp })));
const LoginManagement = lazy(() => import('./AccountSettings').then((module) => ({ default: module.LoginManagement })));
const signOut = () => window.location.replace('/login');

function App() {
  const [auth, setAuth] = useState<AuthStatus | null>(null);
  const [statusError, setStatusError] = useState('');
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    window.addEventListener(sessionEnded, signOut);
    api<AuthStatus>('/auth/status', { signal: controller.signal })
      .then((status) => {
        if (controller.signal.aborted) return;
        const requested = window.location.pathname.replace(/\/$/, '');
        const path = status.authenticated ? (['/drive', '/connections', '/connections/telegram-help', '/account'].includes(requested) ? requested : '/') : '/login';
        if (window.location.pathname !== path) window.location.replace(path);
        else setAuth(status);
      })
      .catch((error: Error) => { if (!controller.signal.aborted) setStatusError(error.message); });
    return () => {
      controller.abort();
      window.removeEventListener(sessionEnded, signOut);
    };
  }, [attempt]);

  if (auth?.authenticated) {
    if (window.location.pathname === '/') return <DashboardHome onLogout={signOut} />;
    const cloud = new URLSearchParams(window.location.search).get('cloud');
    return <Suspense fallback={<p className="empty" role="status">Loading drive.</p>}>
      {window.location.pathname === '/connections' ? <AccountConnections onLogout={signOut} />
        : window.location.pathname === '/connections/telegram-help' ? <TelegramHelp onLogout={signOut} />
        : window.location.pathname === '/account' ? <LoginManagement onLogout={signOut} />
        : cloud === 'google' || cloud === 'mega' ? <CloudFiles provider={cloud} onLogout={signOut} />
        : <FileManager onLogout={signOut} />}
    </Suspense>;
  }

  return <main className="auth-page">
    <Brand />
    <section className="auth-card">
      <LockKeyhole size={25} className="auth-icon" />
      {!auth ? <>
        <h1>{statusError ? 'Connection unavailable' : 'Connecting'}</h1>
        {statusError && <><p role="alert">{statusError}</p><button className="primary" onClick={() => {
          setStatusError('');
          setAttempt((current) => current + 1);
        }}>Try again</button></>}
      </> : !auth.configured ? <>
        <h1>Set up your drive</h1>
        <p>Run <code>npm run owner:setup</code> in the server terminal to create your owner password.</p>
        <button className="primary" onClick={() => setAttempt((current) => current + 1)}>Check setup</button>
      </> : <Login onSuccess={() => window.location.replace('/')} />}
    </section>
  </main>;
}

function Login({ onSuccess }: { onSuccess: () => void }) {
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  async function signIn(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError('');
    try {
      await api('/auth/login', { method: 'POST', body: JSON.stringify({ password }) });
      onSuccess();
    } catch (failure) {
      setError((failure as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return <>
    <h1>Sign in to your drive</h1>
    <form onSubmit={signIn}>
      <label className="field">Owner password
        <input type="password" value={password} onChange={(event) => setPassword(event.target.value)}
          autoComplete="current-password" required maxLength={128} autoFocus />
      </label>
      {error && <p className="error" role="alert">{error}</p>}
      <button className="primary full" disabled={busy}>{busy ? 'Signing in…' : 'Sign in'}</button>
    </form>
  </>;
}

createRoot(document.getElementById('root')!).render(<App />);
