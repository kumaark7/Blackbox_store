import { useEffect, useRef, useState } from 'react';
import type { FormEvent, ReactNode } from 'react';
import {
  Archive, ArrowDownToLine, ArrowLeft, ArrowRight, ChevronRight, Cloud, Ellipsis, File as FileIcon, Folder,
  Eye, Film, FolderPlus, Grid2X2, HardDrive, List, Search, Upload, X,
} from 'lucide-react';
import { api, ApiError, cloudNames, getEntries, getPreview, labels, ROOT_ID, uploadFile } from './api';
import type { CloudProvider, CloudStatus, Entry, Importance, Listing, SavedTransfer, Sort, TeraboxCleanup } from './api';
import { formatSize } from './formatSize';
import { Workspace } from './Workspace';
import { FileSources } from './CloudFiles';
import { FileLoading } from './FileLoading';

type Edit = { action: 'new' | 'rename' | 'move' | 'copy' | 'importance' | 'trash' | 'purge'; entry?: Entry };
type Transfer = { id: number; name: string; size: number; loaded: number; status: string; error?: boolean };

const pageSize = 50;

function connectionLabel(name: string, status: CloudStatus) {
  if (status === 'reconnect') return 'Reconnect ' + name;
  if (status === 'retrying') return name + ' retrying';
  return name + ' connected';
}

function readImportance(): Importance {
  try {
    const saved = localStorage.getItem('blackbox-importance');
    if (saved === 'highly-important' || saved === 'important' || saved === 'backup') return saved;
  } catch { /* Preferences are optional. */ }
  return 'important';
}

function Modal({ title, children, close, className }: { title: string; children: ReactNode; close: () => void; className?: string }) {
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => { dialog.current?.showModal(); }, []);
  return <dialog ref={dialog} className={className} aria-label={title} onCancel={(event) => { event.preventDefault(); close(); }}>
    <header className="modal-heading"><h2>{title}</h2><button className="icon" aria-label="Close" onClick={close}><X size={18} /></button></header>
    {children}
  </dialog>;
}

const previewImages = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);

function FilePreview({ entry, close }: { entry: Entry; close: () => void }) {
  const browserCanShowPdf = navigator.pdfViewerEnabled !== false;
  const pdf = entry.preview === 'pdf';
  const [url, setUrl] = useState('');
  const [error, setError] = useState('');
  const unsupported = pdf && !browserCanShowPdf;
  useEffect(() => {
    if (unsupported) return;
    const controller = new AbortController();
    let objectUrl = '';
    getPreview(entry.id, controller.signal).then((blob) => {
      if (controller.signal.aborted) return;
      if (pdf ? blob.type !== 'application/pdf' : !previewImages.has(blob.type)) {
        throw new Error('The file could not be previewed. You can still download it.');
      }
      objectUrl = URL.createObjectURL(blob);
      setUrl(objectUrl);
    }).catch((failure: Error) => { if (!controller.signal.aborted) setError(failure.message); });
    return () => {
      controller.abort();
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [entry.id, pdf, unsupported]);

  const message = unsupported ? 'PDF preview is unavailable in this browser. Download the file to open it.' : error;
  const failedToRender = () => setError('The file could not be displayed. Download the file to open it.');
  return <Modal title={entry.name} className="preview-dialog" close={close}>
    <div className="preview-stage" aria-busy={!message && !url}>
      {message ? <p className="muted" role="status">{message}</p> : !url ? <p role="status">Loading preview</p> : pdf
        ? <iframe className="pdf-preview" title={'PDF preview of ' + entry.name} src={url}
          referrerPolicy="no-referrer" onError={failedToRender} />
        : <img className="image-preview" alt={entry.name} src={url} onError={failedToRender} />}
    </div>
    <footer className="modal-actions preview-actions">
      <a href={'/api/files/' + entry.id + '/download'}><ArrowDownToLine size={16} /> Download</a>
    </footer>
  </Modal>;
}

export function FileManager({ onLogout }: { onLogout: () => void }) {
  const [query] = useState(() => new URLSearchParams(window.location.search));
  const [view, setView] = useState<'files' | 'trash'>(query.get('view') === 'trash' ? 'trash' : 'files');
  const [parentId, setParent] = useState(ROOT_ID);
  const initialSearch = view === 'files' ? (query.get('q') ?? '').trim().slice(0, 180) : '';
  const [searchInput, setSearchInput] = useState(initialSearch);
  const [search, setSearch] = useState(initialSearch);
  const [priority, setPriority] = useState<Importance | ''>(() => {
    const requested = query.get('priority');
    return requested && Object.hasOwn(labels, requested) ? requested as Importance : '';
  });
  const [provider, setProvider] = useState<CloudProvider | ''>('');
  const [sort, setSort] = useState<Sort>('name');
  const [offset, setOffset] = useState(0);
  const [grid, setGrid] = useState(() => {
    try { return localStorage.getItem('blackbox-files-view') !== 'list'; }
    catch { return true; }
  });
  const [listing, setListing] = useState<Listing | null>(null);
  const [error, setError] = useState('');
  const [revision, setRevision] = useState(0);
  const [edit, setEdit] = useState<Edit | null>(() => view === 'files' && query.get('action') === 'folder' ? { action: 'new' } : null);
  const [uploadChooser, setUploadChooser] = useState(view === 'files' && !initialSearch && query.get('action') === 'upload');
  const [preview, setPreview] = useState<Entry | null>(null);
  const [selected, setSelected] = useState<File[]>([]);
  const [importance, setImportance] = useState<Importance>(readImportance);
  const [transfers, setTransfers] = useState<Transfer[]>([]);
  const [savedTransfers, setSavedTransfers] = useState<SavedTransfer[]>([]);
  const [maxUploadBytes, setMaxUploadBytes] = useState<number>();
  const [cloud, setCloud] = useState<{ googleDrive: CloudStatus; mega: CloudStatus; terabox: CloudStatus; telegram: CloudStatus; cloudOnly: boolean }>(
    { googleDrive: 'off', mega: 'off', terabox: 'off', telegram: 'off', cloudOnly: false });
  const [active, setActive] = useState(false);
  const activeUpload = useRef<AbortController | null>(null);
  const stopQueue = useRef(false);
  const fileInput = useRef<HTMLInputElement>(null);
  const resumeInput = useRef<HTMLInputElement>(null);
  const resumeTarget = useRef<SavedTransfer | null>(null);
  function selectView(grid: boolean) {
    setGrid(grid);
    try { localStorage.setItem('blackbox-files-view', grid ? 'grid' : 'list'); }
    catch { /* Preferences are optional. */ }
  }
  const googleEnabled = cloud.googleDrive === 'connected' || cloud.googleDrive === 'retrying';
  const megaEnabled = cloud.mega === 'connected' || cloud.mega === 'retrying';
  const teraboxEnabled = cloud.terabox === 'connected' || cloud.terabox === 'retrying';
  const telegramEnabled = cloud.telegram === 'connected' || cloud.telegram === 'retrying';
  const backupDestinations = [teraboxEnabled && 'TeraBox', telegramEnabled && 'Telegram'].filter(Boolean).join(' and ');
  const cloudEnabled = googleEnabled || megaEnabled || Boolean(backupDestinations);
  const uploadDestination = importance === 'highly-important' ? (googleEnabled ? 'Google Drive' : '')
    : importance === 'important' ? (megaEnabled ? 'MEGA' : '')
      : (teraboxEnabled ? 'TeraBox' : telegramEnabled ? 'Telegram Backup Channel' : '');
  const requiredProvider = importance === 'highly-important' ? 'Google Drive' : importance === 'important' ? 'MEGA' : 'TeraBox or Telegram Backup Channel';
  const nativeUpload = cloud.cloudOnly && importance !== 'backup' ? (importance === 'important' ? 'mega' : 'google') : null;

  useEffect(() => {
    const controller = new AbortController();
    setListing(null);
    const update = (initial: boolean) => getEntries({
      parentId, sort, search, offset, trash: view === 'trash',
      priority: priority || undefined, provider: provider || undefined,
    }, controller.signal)
      .then((result) => { if (!controller.signal.aborted) setListing(result); })
      .catch((failure: Error) => { if (initial && !controller.signal.aborted) setError(failure.message); });
    void update(true);
    const timer = cloudEnabled ? window.setInterval(() => void update(false), 5000) : undefined;
    return () => { controller.abort(); window.clearInterval(timer); };
  }, [parentId, sort, search, offset, view, revision, cloudEnabled, priority, provider]);

  useEffect(() => {
    const controller = new AbortController();
    const update = () => api<typeof cloud>('/storage', { signal: controller.signal })
      .then((status) => { if (!controller.signal.aborted) setCloud(status); })
      .catch(() => undefined);
    void update();
    const timer = window.setInterval(() => void update(), 5000);
    return () => { controller.abort(); window.clearInterval(timer); };
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    api<{ transfers: SavedTransfer[]; maxUploadBytes: number }>('/transfers', { signal: controller.signal })
      .then((result) => {
        if (controller.signal.aborted) return;
        setSavedTransfers(result.transfers);
        setMaxUploadBytes(result.maxUploadBytes);
      })
      .catch((failure: Error) => { if (!controller.signal.aborted) setError(failure.message); });
    return () => controller.abort();
  }, [revision]);

  useEffect(() => () => {
    stopQueue.current = true;
    activeUpload.current?.abort();
  }, []);

  function navigate(folderId: string, destination: 'files' | 'trash' = 'files') {
    setError('');
    setSearch('');
    setSearchInput('');
    setPriority('');
    setProvider('');
    setOffset(0);
    setParent(folderId);
    setView(destination);
  }

  function refresh() {
    setError('');
    setOffset(0);
    setRevision((current) => current + 1);
  }

  function find(event: FormEvent) {
    event.preventDefault();
    setError('');
    setOffset(0);
    setSearch(searchInput.trim());
    setView('files');
  }

  async function signOut() {
    try {
      await api('/auth/logout', { method: 'POST' });
      onLogout();
    } catch (failure) {
      setError((failure as Error).message);
    }
  }

  function choose(files: File[]) {
    if (files.length && !active && !search && view === 'files') {
      setUploadChooser(false);
      setSelected(files);
    }
  }

  async function runUploads(batch: File[], folderId: string, priority: Importance) {
    setSelected([]);
    setActive(true);
    stopQueue.current = false;
    try { localStorage.setItem('blackbox-importance', priority); } catch { /* Preferences are optional. */ }
    setTransfers(batch.map((file, id) => ({ id, name: file.name, size: file.size, loaded: 0, status: 'Queued' })));
    const update = (id: number, changes: Partial<Transfer>) => setTransfers((current) =>
      current.map((transfer) => transfer.id === id ? { ...transfer, ...changes } : transfer));

    try {
      for (const [id, file] of batch.entries()) {
        if (stopQueue.current) {
          update(id, { status: 'Cancelled' });
          continue;
        }
        update(id, { status: 'Checking file' });
        const controller = new AbortController();
        activeUpload.current = controller;
        try {
          if (maxUploadBytes !== undefined && file.size > maxUploadBytes) throw new Error('The file exceeds the upload limit.');
          await uploadFile(file, folderId, priority, controller.signal, (loaded, status) => {
            update(id, { loaded: Math.min(loaded, file.size), status });
          });
          update(id, { loaded: file.size, status: 'Completed' });
        } catch (failure) {
          const cancelled = (failure as Error).name === 'AbortError';
          update(id, { status: cancelled ? 'Paused' : (failure as Error).message, error: !cancelled });
        }
      }
    } finally {
      activeUpload.current = null;
      setActive(false);
      refresh();
    }
  }

  async function discard(transfer: SavedTransfer) {
    try {
      await api('/transfers/' + transfer.id, { method: 'DELETE' });
      refresh();
    } catch (failure) {
      setError((failure as Error).message);
    }
  }

  async function restore(entry: Entry) {
    try {
      await api('/entries/' + entry.id + '/restore', { method: 'POST' });
      refresh();
    } catch (failure) {
      setError((failure as Error).message);
    }
  }

  const canUpload = view === 'files' && !search;
  const filtered = Boolean(search || priority || provider);
  const title = view === 'trash' ? 'Recycle Bin' : search ? 'Search results' : 'My Files';

  return <Workspace onSignOut={() => void signOut()} trashActive={view === 'trash'} filesNavigation={
        <button className={view === 'files' ? 'nav active' : 'nav'} aria-current={view === 'files' ? 'page' : undefined}
          onClick={() => { navigate(ROOT_ID); window.history.replaceState(null, '', '/drive'); }}>
          <Folder size={18} /> My Files
        </button>
    } storage={<>
        {!cloud.cloudOnly && <div className="storage-label"><HardDrive size={16} /><span>Local storage</span></div>}
        {cloud.googleDrive !== 'off' && <div className="storage-label"><Cloud size={16} />{connectionLabel('Google Drive', cloud.googleDrive)}</div>}
        {cloud.mega !== 'off' && <div className="storage-label"><Cloud size={16} />{connectionLabel('MEGA', cloud.mega)}</div>}
        {cloud.terabox !== 'off' && <div className="storage-label"><Cloud size={16} />{connectionLabel('TeraBox', cloud.terabox)}</div>}
        {cloud.telegram !== 'off' && <div className="storage-label"><Cloud size={16} />{connectionLabel('Telegram', cloud.telegram)}</div>}
    </>}>

    <main className="main">
      <header className="topbar">
        <form className="search" role="search" onSubmit={find}>
          <Search size={17} />
          <input aria-label="Search files and folders" placeholder="Search files and folders" maxLength={180}
            value={searchInput} onChange={(event) => setSearchInput(event.target.value)} />
          {searchInput && <button type="button" className="icon" aria-label="Clear search" onClick={() => {
            setSearchInput(''); setSearch(''); setOffset(0);
          }}><X size={16} /></button>}
        </form>
      </header>

      <div className="content">
        <FileSources />
        <div className="page-title">
          <div><h1>{title}</h1>{search && <p>Results for “{search}”</p>}</div>
          {canUpload && <div className="actions">
            <button onClick={() => setEdit({ action: 'new' })}><FolderPlus size={17} /> New folder</button>
            {cloud.cloudOnly && !cloudEnabled
              ? <a className="primary" href="/connections">Connect a cloud account</a>
              : <button className="primary" disabled={active} onClick={() => fileInput.current?.click()}><Upload size={17} /> Upload</button>}
            <input ref={fileInput} hidden type="file" multiple onChange={(event) => {
              choose(Array.from(event.target.files ?? []));
              event.target.value = '';
            }} />
          </div>}
        </div>

        <section className="file-panel" aria-label={title} onDragOver={(event) => {
          if (canUpload && !active && event.dataTransfer.types.includes('Files')) event.preventDefault();
        }} onDrop={(event) => {
          if (!event.dataTransfer.types.includes('Files')) return;
          event.preventDefault();
          choose(Array.from(event.dataTransfer.files));
        }}>
          <div className="panel-top">
            <nav className="breadcrumbs" aria-label="Folder path">
              {listing?.breadcrumbs.map((crumb, index) => <span key={crumb.id}>
                {index > 0 && <ChevronRight size={13} aria-hidden="true" />}
                <button onClick={() => navigate(crumb.id)}>{crumb.name}</button>
              </span>)}
            </nav>
            <div className="panel-actions">
              {view === 'files' && <>
                <select aria-label="Filter by provider" value={provider} onChange={(event) => {
                  setProvider(event.currentTarget.value as CloudProvider | ''); setOffset(0);
                }}>
                  <option value="">All providers</option>
                  {Object.entries(cloudNames).map(([id, name]) => <option key={id} value={id}>{name}</option>)}
                </select>
                <select aria-label="Filter by priority" value={priority} onChange={(event) => {
                  setPriority(event.currentTarget.value as Importance | ''); setOffset(0);
                }}>
                  <option value="">All priorities</option>
                  {Object.entries(labels).map(([id, label]) => <option key={id} value={id}>{label}</option>)}
                </select>
              </>}
              <select aria-label="Sort files" value={sort} onChange={(event) => {
                setSort(event.target.value as Sort); setOffset(0);
              }}>
                <option value="name">Name</option><option value="updated">Recently changed</option><option value="size">Largest first</option>
              </select>
              <div className="toggle">
                <button className="icon" aria-label="List view" aria-pressed={!grid} onClick={() => selectView(false)}><List size={17} /></button>
                <button className="icon" aria-label="Grid view" aria-pressed={grid} onClick={() => selectView(true)}><Grid2X2 size={16} /></button>
              </div>
            </div>
          </div>

          {error && <p role="alert" className="banner error">{error} <button onClick={refresh}>Refresh</button></p>}
          {!listing ? (!error && <FileLoading />) : listing.items.length === 0 ?
            <div className="empty">
              {view === 'trash' ? <Archive size={34} /> : search ? <Search size={34} /> : <Folder size={34} />}
              <strong>{view === 'trash' ? 'The recycle bin is empty' : filtered ? 'No matching files' : 'This folder is empty'}</strong>
              {canUpload && <span>Drop files here or choose Upload.</span>}
            </div> : <>
              {!grid && <div className="file-row table-heading"><span>Name</span><span>Importance</span><span>Size</span><span>Modified</span><span /></div>}
              <ul className={grid ? 'file-grid' : 'file-list'}>
                {listing.items.map((entry) => <FileRow key={entry.id} entry={entry} grid={grid} trash={view === 'trash'}
                  open={() => navigate(entry.id)} onPreview={() => setPreview(entry)}
                  onEdit={(action) => setEdit({ action, entry })} restore={() => void restore(entry)} />)}
              </ul>
            </>}

          {listing && (offset > 0 || listing.nextOffset !== null) && <div className="paging">
            <button disabled={offset === 0} onClick={() => setOffset((current) => Math.max(0, current - pageSize))}><ArrowLeft size={16} /> Previous</button>
            <span>Page {Math.floor(offset / pageSize) + 1}</span>
            <button disabled={listing.nextOffset === null} onClick={() => setOffset(listing.nextOffset ?? 0)}>Next <ArrowRight size={16} /></button>
          </div>}
        </section>

        {transfers.length > 0 && <section className="transfers" aria-label="Uploads">
          <header><h2>Uploads</h2>
            {active ? <button onClick={() => { stopQueue.current = true; activeUpload.current?.abort(); }}>Pause uploads</button>
              : <button onClick={() => { setTransfers([]); refresh(); }}>Clear activity</button>}
          </header>
          <ul aria-live="polite">{transfers.map((transfer) => <li key={transfer.id}>
            <span className="file-name">{transfer.name}</span>
            <progress aria-label={'Upload progress for ' + transfer.name} max={Math.max(transfer.size, 1)}
              value={transfer.status === 'Completed' ? Math.max(transfer.size, 1) : transfer.loaded} />
            <span className={transfer.error ? 'error' : 'muted'}>{transfer.status}</span>
          </li>)}</ul>
        </section>}

        {!active && savedTransfers.length > 0 && <section className="transfers" aria-label="Pending uploads">
          <header><h2>Pending uploads</h2></header>
          <input ref={resumeInput} hidden type="file" onChange={(event) => {
            const file = event.target.files?.[0];
            const transfer = resumeTarget.current;
            event.target.value = '';
            if (!file || !transfer) return;
            if (file.name.trim().normalize('NFC') !== transfer.name || file.size !== transfer.size) {
              setError('Choose the original file to resume this upload.');
              return;
            }
            void runUploads([file], transfer.parentId, transfer.importance);
          }} />
          <ul>{savedTransfers.map((transfer) => <li key={transfer.id}>
            <span className="file-name">{transfer.name}</span>
            <progress aria-label={'Saved progress for ' + transfer.name} max={Math.max(transfer.size, 1)} value={transfer.received} />
            <div className="actions">
              <button onClick={() => { resumeTarget.current = transfer; resumeInput.current?.click(); }}>Resume</button>
              <button onClick={() => void discard(transfer)}>Discard</button>
            </div>
          </li>)}</ul>
        </section>}
      </div>
    </main>

    {uploadChooser && <Modal title="Upload files" close={() => setUploadChooser(false)}>
      <div className="upload-destinations">
        {googleEnabled && <a className="primary" href="/drive?cloud=google"><Cloud size={17} /> Google Drive</a>}
        {megaEnabled && <a className="primary" href="/drive?cloud=mega"><Cloud size={17} /> MEGA</a>}
        {Boolean(backupDestinations) && <button onClick={() => { setImportance('backup'); fileInput.current?.click(); }}>
          <Archive size={17} /> Choose backup files
        </button>}
        {!cloud.cloudOnly && <button onClick={() => fileInput.current?.click()}><Upload size={17} /> Choose files</button>}
        {cloud.cloudOnly && !cloudEnabled && <a className="primary" href="/connections">Connect a cloud account</a>}
      </div>
    </Modal>}
    {selected.length > 0 && <Modal title={selected.length === 1 ? 'Upload file' : 'Upload files'} close={() => setSelected([])}>
      <form onSubmit={(event) => { event.preventDefault(); void runUploads(selected, parentId, importance); }}>
        <ul className="upload-files">{selected.map((file, index) => <li key={index}><span>{file.name}</span><span>{formatSize(file.size)}</span></li>)}</ul>
        <ImportanceField value={importance} change={setImportance} />
        {nativeUpload ? <p>Open the <a href={'/drive?cloud=' + nativeUpload}>{requiredProvider} tab</a> to upload directly to its folders.</p>
          : cloud.cloudOnly ? (uploadDestination
          ? <p className="muted">Encrypted storage on {uploadDestination}.</p>
          : <p className="warning">Connect {requiredProvider} in <a href="/connections">Account connections</a> before uploading.</p>)
          : <><p className="muted">Encrypted local storage</p>
        {importance === 'highly-important' && <p className={googleEnabled ? 'muted' : 'warning'}>{googleEnabled
          ? 'A verified Google Drive copy will be added in the background.'
          : 'A Google Drive copy will be added after you connect your account.'}</p>}
        {importance === 'important' && <p className={megaEnabled ? 'muted' : 'warning'}>{megaEnabled
          ? 'A verified MEGA copy will be added in the background.'
          : 'A MEGA copy will be added after you connect your account.'}</p>}
        {importance === 'backup' && <p className={backupDestinations ? 'muted' : 'warning'}>{backupDestinations
          ? 'Blackbox will verify a backup copy on ' + backupDestinations + '.'
          : 'Connect TeraBox or Telegram to add a cloud backup.'}</p>}</>}
        <footer className="modal-actions"><button type="button" onClick={() => setSelected([])}>Cancel</button>
          <button className="primary" disabled={Boolean(nativeUpload) || (cloud.cloudOnly && !uploadDestination)}>Start upload</button></footer>
      </form>
    </Modal>}

    {edit && <EntryDialog edit={edit} parentId={parentId} close={() => setEdit(null)} success={refresh} />}
    {preview && <FilePreview key={preview.id} entry={preview} close={() => setPreview(null)} />}
  </Workspace>;
}

function TileThumbnail({ entry, onPreview }: { entry: Entry; onPreview: () => void }) {
  const [failed, setFailed] = useState(false);
  const tile = <>
    <img src={'/api/files/' + entry.id + '/thumbnail'} loading="lazy" decoding="async" alt="" onError={() => setFailed(true)} />
    {entry.thumbnail === 'video' && <span className="tile-video" aria-hidden="true"><Film size={15} /></span>}
  </>;
  if (failed) return <div className="tile-thumbnail" aria-hidden="true">{entry.thumbnail === 'video' ? <Film size={26} /> : <FileIcon size={26} />}</div>;
  return entry.preview === 'image'
    ? <button type="button" className="tile-thumbnail" aria-label={'Preview ' + entry.name} onClick={onPreview}>{tile}</button>
    : <div className="tile-thumbnail" aria-hidden="true">{tile}</div>;
}

function FileRow({ entry, grid, trash, open, onPreview, onEdit, restore }: {
  entry: Entry; grid: boolean; trash: boolean; open: () => void; onPreview: () => void;
  onEdit: (action: Edit['action']) => void; restore: () => void;
}) {
  const folder = entry.kind === 'folder';
  const replicas = entry.cloudCopies.map((provider) => cloudNames[provider]).join(', ');
  const download = '/api/files/' + entry.id + '/download';
  const icon = folder ? <Folder size={grid ? 28 : 18} /> : <FileIcon size={grid ? 28 : 18} />;
  const thumbnail = grid && !trash && entry.thumbnail;
  return <li className={grid ? 'file-tile' : 'file-row'}>
    {thumbnail && <TileThumbnail key={entry.updatedAt} entry={entry} onPreview={onPreview} />}
    <div className="entry-name">
      {!thumbnail && <span className={folder ? 'entry-icon folder' : 'entry-icon'}>{icon}</span>}
      {trash ? <span className="file-name">{entry.name}</span> : folder ?
        <button className="text-button file-name" title={entry.name} onClick={open}>{entry.name}</button> : entry.preview ?
        <button className="text-button file-name" title={entry.name} onClick={onPreview}>{entry.name}</button> :
        <a className="file-name" title={entry.name} href={download}>{entry.name}</a>}
    </div>
    <span className="entry-priority">{entry.deletionPending ? <span className="priority degraded">Deletion pending</span> :
      entry.importance && <span data-priority={entry.importance} className={entry.protection === 'degraded' ? 'priority degraded' : 'priority'}
      title={entry.protection === 'degraded' ? 'Awaiting a verified Google Drive copy' + (replicas ? '. Verified on ' + replicas : '')
        : replicas ? 'Verified cloud copies on ' + replicas : undefined}>{labels[entry.importance]}
      {replicas && <>
        <Cloud size={12} className="replica-icon" aria-hidden="true" />
        <span className="sr-only">, verified cloud copies on {replicas}</span>
      </>}</span>}</span>
    <span className="entry-size">{entry.size === null ? '' : formatSize(entry.size)}</span>
    <time className="entry-date" dateTime={new Date(entry.updatedAt).toISOString()}>{new Date(entry.updatedAt).toLocaleDateString()}</time>
    <div className="entry-actions">
      <details name="entry-actions">
        <summary className="icon" aria-label={'Actions for ' + entry.name}><Ellipsis size={19} /></summary>
        <div className="menu" onClick={(event) => event.currentTarget.closest('details')?.removeAttribute('open')}>
          {trash ? <>
            {!entry.deletionPending && <button onClick={restore}>Restore</button>}
            <button className="error" onClick={() => onEdit('purge')}>
              {entry.deletionPending ? 'Finish permanent deletion' : 'Delete permanently'}
            </button>
          </> : <>
            {entry.preview && <button onClick={onPreview}><Eye size={15} /> Preview</button>}
            {!folder && <a href={download}><ArrowDownToLine size={15} /> Download</a>}
            <button onClick={() => onEdit('rename')}>Rename</button><button onClick={() => onEdit('move')}>Move</button>
            {!folder && <><button onClick={() => onEdit('copy')}>Copy</button><button onClick={() => onEdit('importance')}>Change importance</button></>}
            <button className="error" onClick={() => onEdit('trash')}>Move to recycle bin</button>
          </>}
        </div>
      </details>
    </div>
  </li>;
}

function ImportanceField({ value, change }: { value: Importance; change: (value: Importance) => void }) {
  return <label className="field">Importance
    <select value={value} onChange={(event) => change(event.target.value as Importance)}>
      {Object.entries(labels).map(([key, label]) => <option key={key} value={key}>{label}</option>)}
    </select>
  </label>;
}

function EntryDialog({ edit, parentId, close, success }: { edit: Edit; parentId: string; close: () => void; success: () => void }) {
  const { entry, action } = edit;
  const [name, setName] = useState(action === 'copy' ? 'Copy of ' + (entry?.name ?? '') : (entry?.name ?? ''));
  const [destination, setDestination] = useState(entry?.parentId ?? parentId);
  const [importance, setImportance] = useState<Importance>(entry?.importance ?? 'important');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const titles = {
    new: 'New folder', rename: 'Rename item', move: 'Move item', copy: 'Copy file',
    importance: 'Change importance', trash: 'Move to recycle bin', purge: 'Delete permanently',
  };
  const [cleanup, setCleanup] = useState<TeraboxCleanup>();
  const [confirmed, setConfirmed] = useState(false);
  const needsName = ['new', 'rename', 'copy'].includes(action);
  const hasDestination = action === 'move' || action === 'copy';

  async function save(event: FormEvent) {
    event.preventDefault();
    if (busy || (cleanup && !confirmed)) return;
    setBusy(true);
    setError('');
    const path = '/entries/' + entry?.id;
    try {
      if (action === 'new') await api('/folders', { method: 'POST', body: JSON.stringify({ name, parentId }) });
      else if (action === 'trash') await api(path, { method: 'DELETE' });
      else if (action === 'purge') await api(path + '/permanent', {
        method: 'DELETE', body: cleanup && JSON.stringify({ teraboxConfirmation: cleanup.confirmation }),
      });
      else if (action === 'copy') await api(path + '/copy', { method: 'POST', body: JSON.stringify({ name, parentId: destination }) });
      else {
        const changes = action === 'rename' ? { name } : action === 'move' ? { parentId: destination } : { importance };
        await api(path, { method: 'PATCH', body: JSON.stringify(changes) });
      }
      success();
      close();
    } catch (failure) {
      if (failure instanceof ApiError && failure.teraboxCleanup) {
        setCleanup(failure.teraboxCleanup);
        setConfirmed(false);
      } else setError((failure as Error).message);
      if (action === 'purge') success();
      setBusy(false);
    }
  }

  return <Modal title={titles[action]} close={() => { if (!busy) close(); }}>
    <form onSubmit={save}>
      {action === 'trash' && <p>Move <strong>{entry?.name}</strong> to the recycle bin?</p>}
      {action === 'purge' && !cleanup && <p>Permanently delete <strong>{entry?.name}</strong>
        {entry?.kind === 'folder' ? ' and everything inside it' : ''}? This cannot be undone.</p>}
      {cleanup && <>
        <p>Find these encrypted copies by filename in the TeraBox Recycle Bin and permanently delete each matching item.</p>
        <ul className="upload-files">{cleanup.paths.map((path) => <li key={path}>{path}</li>)}</ul>
        <label><input type="checkbox" checked={confirmed} onChange={(event) => setConfirmed(event.target.checked)} />
          {' '}I checked TeraBox and its Recycle Bin for these copies and removed any matches.</label>
      </>}
      {needsName && <label className="field">Name<input value={name} maxLength={180} required autoFocus
        onChange={(event) => setName(event.target.value)} /></label>}
      {hasDestination && <FolderPicker folder={destination} change={setDestination} excluded={action === 'move' ? entry?.id : undefined} />}
      {action === 'importance' && <ImportanceField value={importance} change={setImportance} />}
      {error && <p className="error" role="alert">{error}</p>}
      <footer className="modal-actions"><button type="button" autoFocus={action === 'purge'} disabled={busy} onClick={close}>Cancel</button>
        <button className={action === 'purge' ? 'danger' : 'primary'} disabled={busy || Boolean(cleanup && !confirmed)}>
          {busy ? (action === 'purge' ? 'Deleting…' : 'Saving…') :
            (cleanup ? 'Finish permanent deletion' : action === 'trash' || action === 'purge' ? titles[action] : 'Save')}
        </button></footer>
    </form>
  </Modal>;
}

function FolderPicker({ folder, change, excluded }: { folder: string; change: (id: string) => void; excluded?: string }) {
  const [listing, setListing] = useState<Listing | null>(null);
  const [offset, setOffset] = useState(0);
  const [error, setError] = useState('');

  useEffect(() => {
    const controller = new AbortController();
    setError('');
    setListing(null);
    getEntries({ parentId: folder, offset }, controller.signal)
      .then((result) => { if (!controller.signal.aborted) setListing(result); })
      .catch((failure: Error) => { if (!controller.signal.aborted) setError(failure.message); });
    return () => controller.abort();
  }, [folder, offset]);

  const folders = listing?.items.filter((entry) => entry.kind === 'folder' && entry.id !== excluded);
  return <fieldset className="folder-picker">
    <legend>Destination folder</legend>
    <div className="breadcrumbs">
      {listing?.breadcrumbs.map((crumb) => <button type="button" key={crumb.id} onClick={() => {
        setOffset(0); change(crumb.id);
      }}>{crumb.name}</button>)}
    </div>
    {error && <p className="error" role="alert">{error}</p>}
    {!listing && !error && <p className="muted">Loading folders…</p>}
    <ul>{folders?.map((entry) => <li key={entry.id}><button type="button" onClick={() => {
      setOffset(0); change(entry.id);
    }}><Folder size={16} /> {entry.name}</button></li>)}</ul>
    {folders?.length === 0 && <p className="muted">No subfolders on this page.</p>}
    {listing && (offset > 0 || listing.nextOffset !== null) && <div className="paging">
      <button type="button" disabled={offset === 0} onClick={() => setOffset(offset - pageSize)}>Previous</button>
      <button type="button" disabled={listing.nextOffset === null} onClick={() => setOffset(listing.nextOffset ?? 0)}>Next</button>
    </div>}
  </fieldset>;
}
