import { useEffect, useRef, useState } from 'react';
import type { FormEvent, ReactNode } from 'react';
import { api } from './api';
import type { CloudStatus } from './api';
import { Workspace } from './Workspace';

const providers = {
  googleDrive: 'Google Drive', mega: 'MEGA', terabox: 'TeraBox',
  telegram: 'Telegram Backup Channel', telegramBot: 'Telegram Upload Bot',
} as const;
type Provider = keyof typeof providers;
type Step = { kind: 'google'; url: string } | { kind: 'qr' } | { kind: 'input'; id: string; message: string }
  | { kind: 'teraboxWeb'; id: string; url: string };
type Connections = {
  providers: Record<Provider, CloudStatus>;
  googleReady: boolean;
  teraboxReady: boolean;
  telegramBotUsername?: string;
  flow: { provider: Provider; status: 'pending' | 'connected' | 'failed'; error?: string; step?: Step } | null;
};
type Sessions = { expiresAt: number; activeSessions: number };
const statusLabels: Record<CloudStatus, string> = { off: 'Disconnected', reconnect: 'Reconnect required', retrying: 'Sync retrying', connected: 'Connected' };
const providerKeys = Object.keys(providers) as Provider[];

function SettingsPage({ page, title, children, onLogout }: {
  page: 'connections' | 'account'; title: string; children: ReactNode; onLogout: () => void;
}) {
  const [error, setError] = useState('');
  async function signOut() {
    try {
      await api('/auth/logout', { method: 'POST' });
      onLogout();
    } catch (failure) {
      setError((failure as Error).message);
    }
  }
  return <Workspace page={page} onSignOut={() => void signOut()}>
    <main className="main"><div className="content settings-page">
      <h1>{title}</h1>
      {error && <p className="error" role="alert">{error}</p>}
      {children}
    </div></main>
  </Workspace>;
}

function field(label: string, name: string, type = 'text', maxLength = 1024) {
  return <label className="field">{label}<input required name={name} type={type} maxLength={maxLength} autoComplete="off" /></label>;
}

function ProviderFields({ provider }: { provider: Exclude<Provider, 'googleDrive' | 'terabox'> }) {
  if (provider === 'mega') return <>
    {field('Email', 'email', 'email', 254)}
    {field('MEGA password', 'password', 'password')}
    <details><summary>Use a different folder</summary><label className="field">MEGA folder
      <input name="folder" placeholder="BlackboxStore" maxLength={180} pattern="[A-Za-z0-9_/-]+" />
    </label></details>
  </>;
  if (provider === 'telegramBot') return <>
    <p className="muted">Use a dedicated bot from BotFather. Send documents in a private chat and choose their storage priority.</p>
    {field('Bot token', 'botToken', 'password', 221)}
    {field('Your numeric Telegram user ID', 'ownerId', 'text', 16)}
  </>;
  return <>
    <label className="field">API ID<input name="apiId" type="number" min="1" max="2147483647" required /></label>
    {field('API hash', 'apiHash', 'password', 32)}
    {field('Private channel ID', 'channelId', 'text', 16)}
  </>;
}

function TeraBoxFrame({ step, onCode }: { step: Extract<Step, { kind: 'teraboxWeb' }>; onCode: (id: string, code: string) => Promise<void> }) {
  const frame = useRef<HTMLIFrameElement>(null);
  const submitted = useRef(false);
  useEffect(() => {
    function receive(event: MessageEvent) {
      if (event.origin !== 'https://www.terabox.com' || event.source !== frame.current?.contentWindow || submitted.current) return;
      let payload: unknown = event.data;
      if (typeof payload === 'string') {
        if (payload.length > 16_384) return;
        try { payload = JSON.parse(payload); } catch { return; }
      }
      if (!payload || typeof payload !== 'object' || !('event' in payload) || payload.event !== 'teraboxOauth') return;
      const data = 'data' in payload ? payload.data : undefined;
      const code = 'code' in payload ? payload.code : typeof data === 'object' && data && 'code' in data ? data.code : data;
      if (typeof code !== 'string' || !code || code.length > 1024) return;
      submitted.current = true;
      void onCode(step.id, code).finally(() => { submitted.current = false; });
    }
    window.addEventListener('message', receive);
    return () => window.removeEventListener('message', receive);
  }, [onCode, step.id]);
  return <iframe className="terabox-login" ref={frame} title="Sign in to TeraBox" src={step.url}
    sandbox="allow-same-origin allow-scripts allow-forms allow-popups allow-popups-to-escape-sandbox" referrerPolicy="no-referrer" />;
}

export function AccountConnections({ onLogout }: { onLogout: () => void }) {
  const [state, setState] = useState<Connections | null>(null);
  const [provider, setProvider] = useState<Provider>('googleDrive');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const pending = state?.flow?.status === 'pending';
  useEffect(() => {
    const controller = new AbortController();
    const update = () => api<Connections>('/connections', { signal: controller.signal })
      .then((result) => { if (!controller.signal.aborted) setState(result); })
      .catch((failure: Error) => { if (!controller.signal.aborted) setError(failure.message); });
    void update();
    const timer = pending ? window.setInterval(() => void update(), 1250) : undefined;
    return () => { controller.abort(); window.clearInterval(timer); };
  }, [pending]);

  async function start(input: Record<string, unknown>, form?: HTMLFormElement) {
    setBusy(true);
    setError('');
    try {
      const body = { ...input, provider, ...(provider === 'telegram' ? { apiId: Number(input.apiId) } : {}) };
      const result = await api<Connections>('/connections', { method: 'POST', body: JSON.stringify(body) });
      form?.reset();
      setState(result);
      if (result.flow?.step?.kind === 'google') window.location.assign(result.flow.step.url);
    } catch (failure) {
      setError((failure as Error).message);
    } finally {
      setBusy(false);
    }
  }

  function startForm(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const input = Object.fromEntries(new FormData(form));
    if (provider === 'mega' && !input.folder) delete input.folder;
    void start(input, form);
  }

  function reply(event: FormEvent<HTMLFormElement>, id: string) {
    event.preventDefault();
    const form = event.currentTarget;
    const value = String(new FormData(form).get('value') ?? '');
    form.reset();
    void completeStep(id, value);
  }

  async function completeStep(id: string, value: string) {
    setBusy(true);
    setError('');
    try {
      await api('/connections/answer', { method: 'POST', body: JSON.stringify({ id, value }) });
      setState(await api<Connections>('/connections'));
    } catch (failure) {
      setError((failure as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function cancel() {
    setError('');
    try { await api('/connections/flow', { method: 'DELETE' }); }
    catch (failure) { setError((failure as Error).message); }
  }

  async function disconnectGoogle() {
    if (!window.confirm('Disconnect Google Drive? Files stored there remain in your account. Reconnect the same account to access them through Blackbox.')) return;
    setBusy(true);
    setError('');
    try {
      setState(await api<Connections>('/connections/google', { method: 'DELETE' }));
    } catch (failure) {
      setError((failure as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const flow = state?.flow;
  const step = flow?.step;
  const connectLabel = (state?.providers[provider] === 'off' ? 'Connect ' : 'Reconnect ') + providers[provider];
  const setupForm = provider !== 'googleDrive' && provider !== 'terabox' && <form key={provider} className="settings-form" onSubmit={startForm}>
    <ProviderFields provider={provider} />
    <button className="primary" disabled={busy}>{busy ? 'Starting connection' : connectLabel}</button>
  </form>;
  const teraMethods = <div className="connection-methods" aria-label="TeraBox sign-in methods">
    <button type="button" className="primary" disabled={busy} onClick={() => void start({ method: 'web' })}>Sign in on TeraBox</button>
    <button type="button" disabled={busy} onClick={() => void start({ method: 'qr' })}>Scan a QR code</button>
  </div>;
  return <SettingsPage page="connections" title="Account connections" onLogout={onLogout}>
    {error && <p className="error" role="alert">{error}</p>}
    {state ? <>
      <div className="provider-options">
        {providerKeys.map((key) => <button type="button" key={key} disabled={pending || busy}
          aria-pressed={provider === key} onClick={() => setProvider(key)}>
          <strong>{providers[key]}</strong><small>{statusLabels[state.providers[key]]}</small>
        </button>)}
      </div>
      {pending && flow ? <section className="settings-panel">
        <h2>Connect {providers[flow.provider]}</h2>
        {step?.kind === 'google' ? <a href={step.url}>Continue with Google</a>
          : step?.kind === 'teraboxWeb' ? <TeraBoxFrame key={step.id} step={step} onCode={completeStep} />
          : step?.kind === 'qr' ? <><p>Scan this QR code with the TeraBox mobile app.</p>
            <img className="connection-qr" src="/api/connections/qr" alt="TeraBox authorization QR code" /></>
            : step?.kind === 'input' ? <form key={step.id} className="settings-form" onSubmit={(event) => reply(event, step.id)}>
              {field(step.message, 'value', 'password')}
              <button className="primary" disabled={busy}>Continue</button>
            </form> : <p role="status">Waiting for {providers[flow.provider]}</p>}
        <button type="button" onClick={() => void cancel()}>Cancel connection</button>
      </section> : <section className="settings-panel">
        {flow?.status === 'failed' && <p className="error" role="alert">{flow.error}</p>}
        {flow?.status === 'connected' && flow.provider !== 'googleDrive' && flow.provider !== 'mega' && flow.provider !== 'terabox'
          && <p role="status">{providers[flow.provider]} connected.</p>}
        <h2>{providers[provider]}</h2>
        {(provider === 'telegram' || provider === 'telegramBot') && <a href="/connections/telegram-help"
          target="_blank" rel="noopener noreferrer">Telegram setup instructions (opens in a new tab)</a>}
        {provider === 'telegramBot' && state.telegramBotUsername && <a href={'https://t.me/' + state.telegramBotUsername}
          target="_blank" rel="noopener noreferrer">Open @{state.telegramBotUsername} in Telegram</a>}
        {provider === 'googleDrive' ? (
          state.providers.googleDrive === 'connected' || state.providers.googleDrive === 'retrying' ? <>
            <p role="status">{statusLabels[state.providers.googleDrive]}</p>
            <div className="connection-methods">
              {state.googleReady && <button type="button" disabled={busy} onClick={() => void start({})}>Reconnect Google Drive</button>}
              <button type="button" disabled={busy} onClick={() => void disconnectGoogle()}>Disconnect Google Drive</button>
            </div>
          </>
            : state.googleReady ? <button type="button" className="primary" disabled={busy}
              onClick={() => void start({})}>{busy ? 'Opening Google…'
                : state.providers.googleDrive === 'off' ? 'Connect Google Drive' : 'Reconnect Google Drive'}</button>
              : <p className="muted">Google Drive sign-in is unavailable until the site administrator enables it.</p>
        ) : provider === 'mega' && (state.providers.mega === 'connected' || state.providers.mega === 'retrying') ? <>
          <p role="status">{statusLabels[state.providers.mega]}</p>
          <details><summary>Reconnect MEGA</summary>{setupForm}</details>
        </> : provider === 'terabox' ? (
          !state.teraboxReady ? <p className="muted">TeraBox sign-in is unavailable until the site administrator enables it.</p>
            : state.providers.terabox === 'connected' || state.providers.terabox === 'retrying' ? <>
              <p role="status">{statusLabels[state.providers.terabox]}</p>
              <details><summary>Reconnect TeraBox</summary>{teraMethods}</details>
            </> : teraMethods
        ) : setupForm}
      </section>}
    </> : !error && <p role="status">Loading connections</p>}
  </SettingsPage>;
}

export function TelegramHelp({ onLogout }: { onLogout: () => void }) {
  return <SettingsPage page="connections" title="Telegram setup" onLogout={onLogout}>
    <p>Use the Upload Bot to send files to Blackbox from Telegram. Use the Backup Channel to store encrypted copies of files in Telegram. You can set up either or both.</p>
    <p><a href="https://t.me/EZ_IDS_Finder_bot" target="_blank" rel="noopener noreferrer">@EZ_IDS_Finder_bot</a> finds numeric IDs.
      Enter tokens, API hashes, and login codes in Blackbox when prompted. Keep them out of Telegram chats.</p>
    <section className="settings-panel">
      <h2>Upload bot</h2>
      <ol className="setup-steps">
        <li>Open <a href="https://t.me/EZ_IDS_Finder_bot" target="_blank" rel="noopener noreferrer">@EZ_IDS_Finder_bot</a>,
          tap <strong>Start</strong>, and send <code>/id</code>. Copy your numeric <strong>User ID</strong>.</li>
        <li>Open <a href="https://t.me/BotFather" target="_blank" rel="noopener noreferrer">@BotFather</a> and send <code>/newbot</code>.
          Follow the prompts to create a dedicated Blackbox upload bot, then copy its token.</li>
        <li>In Blackbox, open <strong>Account connections → Telegram Upload Bot</strong>. Paste the dedicated bot’s token into
          <strong> Bot token</strong> and your ID into <strong>Your numeric Telegram user ID</strong>. Click <strong>Connect Telegram Upload Bot</strong>.</li>
        <li>Open your upload bot using the link in Blackbox. Tap <strong>Start</strong>, send a small document as a file, and choose its storage priority.</li>
      </ol>
    </section>
    <section className="settings-panel">
      <h2>Backup channel</h2>
      <p>The Blackbox server needs the Telegram client installed and <code>TELEGRAM_CLIENT_DIR</code> set.
        {' '}<a href="https://github.com/kumaark7/Blackbox_store/blob/main/docs/TELEGRAM_SETUP.md"
          target="_blank" rel="noopener noreferrer">Server setup instructions</a>.</p>
      <ol className="setup-steps">
        <li>Create a private broadcast channel with your Telegram account and keep message auto-delete off.</li>
        <li>Open <a href="https://t.me/EZ_IDS_Finder_bot" target="_blank" rel="noopener noreferrer">@EZ_IDS_Finder_bot</a>, tap
          <strong> Select Channel</strong>, and pick your backup channel. If the ID is shown as <code>-1001234567890</code>,
          enter <code>1234567890</code> in Blackbox. If the selector doesn’t show the channel, post a test message and copy
          its link. In <code>https://t.me/c/1234567890/17</code>, use <code>1234567890</code>.</li>
        <li>Sign in at <a href="https://my.telegram.org" target="_blank" rel="noopener noreferrer">my.telegram.org</a> with the
          account that owns the channel. Open <strong>API development tools</strong> and copy your <strong>API ID</strong> and
          <strong> API hash</strong>. Create an app there if you haven’t already.</li>
        <li>In Blackbox, open <strong>Account connections → Telegram Backup Channel</strong>. Enter the API ID, API hash, and
          private channel ID. Click <strong>Connect Telegram Backup Channel</strong> and follow the phone and verification prompts.</li>
        <li>With TeraBox disconnected, upload a small file in Blackbox and choose <strong>Backup</strong>. Once verified,
          its Telegram copy appears as an encrypted document in your channel.</li>
      </ol>
    </section>
  </SettingsPage>;
}

export function LoginManagement({ onLogout }: { onLogout: () => void }) {
  const [sessions, setSessions] = useState<Sessions | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    const controller = new AbortController();
    api<Sessions>('/account/sessions', { signal: controller.signal })
      .then((result) => { if (!controller.signal.aborted) setSessions(result); })
      .catch((failure: Error) => { if (!controller.signal.aborted) setError(failure.message); });
    return () => controller.abort();
  }, []);

  async function submit(path: string, body?: string) {
    setBusy(true);
    setError('');
    try {
      await api(path, { method: 'POST', body });
      if (path === '/account/password') onLogout();
      else setSessions(await api<Sessions>('/account/sessions'));
    } catch (failure) {
      setError((failure as Error).message);
    } finally {
      setBusy(false);
    }
  }

  function changePassword(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const { current, password, confirmation } = Object.fromEntries(new FormData(form));
    if (password !== confirmation) {
      setError('The new passwords do not match.');
      return;
    }
    form.reset();
    void submit('/account/password', JSON.stringify({ current, password }));
  }

  return <SettingsPage page="account" title="Login management" onLogout={onLogout}>
    {error && <p className="error" role="alert">{error}</p>}
    <section className="settings-panel">
      <h2>Sessions</h2>
      {sessions && <>
        <p role="status">{sessions.activeSessions} active {sessions.activeSessions === 1 ? 'session' : 'sessions'}</p>
        <p className="muted">This session expires {new Date(sessions.expiresAt).toLocaleString()}.</p>
        <button type="button" disabled={busy || sessions.activeSessions < 2}
          onClick={() => void submit('/account/sessions/revoke-others')}>Sign out other sessions</button>
      </>}
    </section>
    <section className="settings-panel">
      <h2>Change owner password</h2>
      <p className="muted">Changing the password signs out every session. Use 12 to 128 characters.</p>
      <form className="settings-form" onSubmit={changePassword}>
        <label className="field">Current password<input name="current" type="password" required maxLength={128} autoComplete="current-password" /></label>
        <label className="field">New password<input name="password" type="password" required minLength={12} maxLength={128} autoComplete="new-password" /></label>
        <label className="field">Confirm new password<input name="confirmation" type="password" required minLength={12} maxLength={128} autoComplete="new-password" /></label>
        <button className="primary" disabled={busy}>Change password</button>
      </form>
    </section>
  </SettingsPage>;
}
