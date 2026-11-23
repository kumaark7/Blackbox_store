import { useEffect, useRef, useState } from 'react';
import type { FormEvent, ReactNode } from 'react';
import {
  Archive, ArrowDownToLine, ArrowLeft, ArrowRight, ChevronRight, Ellipsis, File as FileIcon, Folder,
  FolderPlus, Grid2X2, HardDrive, List, LogOut, Search, Trash2, Upload, X,
} from 'lucide-react';
import { api, getEntries, labels, ROOT_ID, uploadFile } from './api';
import type { Entry, Importance, Listing, Sort } from './api';
import { Brand } from './Brand';

type Edit = { action: 'new' | 'rename' | 'move' | 'copy' | 'importance' | 'trash' | 'purge'; entry?: Entry };
type Transfer = { id: number; name: string; size: number; loaded: number; status: string; error?: boolean };

const pageSize = 50;

function formatSize(bytes: number) {
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let index = 0;
  while (bytes >= 1024 && index < units.length - 1) {
    bytes /= 1024;
    index++;
  }
  return new Intl.NumberFormat(undefined, { maximumFractionDigits: index ? 1 : 0 }).format(bytes) + ' ' + units[index];
}

function readImportance(): Importance {
  try {
    const saved = localStorage.getItem('blackbox-importance');
    if (saved === 'highly-important' || saved === 'important' || saved === 'backup') return saved;
  } catch { /* Preferences are optional. */ }
  return 'important';
}

function Modal({ title, children, close }: { title: string; children: ReactNode; close: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => { dialog.current?.showModal(); }, []);
  return <dialog ref={dialog} aria-label={title} onCancel={(event) => { event.preventDefault(); close(); }}>
    <header className="modal-heading"><h2>{title}</h2><button className="icon" aria-label="Close" onClick={close}><X size={18} /></button></header>
    {children}
  </dialog>;
}

export function FileManager({ onLogout }: { onLogout: () => void }) {
  const [view, setView] = useState<'files' | 'trash'>('files');
  const [parentId, setParent] = useState(ROOT_ID);
  const [searchInput, setSearchInput] = useState('');
  const [search, setSearch] = useState('');
  const [sort, setSort] = useState<Sort>('name');
  const [offset, setOffset] = useState(0);
  const [grid, setGrid] = useState(false);
  const [listing, setListing] = useState<Listing | null>(null);
  const [error, setError] = useState('');
  const [revision, setRevision] = useState(0);
  const [edit, setEdit] = useState<Edit | null>(null);
  const [selected, setSelected] = useState<File[]>([]);
  const [importance, setImportance] = useState<Importance>(readImportance);
  const [transfers, setTransfers] = useState<Transfer[]>([]);
  const [active, setActive] = useState(false);
  const activeUpload = useRef<(() => void) | null>(null);
  const stopQueue = useRef(false);
  const fileInput = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const controller = new AbortController();
    setListing(null);
    getEntries({ parentId, sort, search, offset, trash: view === 'trash' }, controller.signal)
      .then((result) => { if (!controller.signal.aborted) setListing(result); })
      .catch((failure: Error) => { if (!controller.signal.aborted) setError(failure.message); });
    return () => controller.abort();
  }, [parentId, sort, search, offset, view, revision]);

  useEffect(() => () => {
    stopQueue.current = true;
    activeUpload.current?.();
  }, []);

  function navigate(folderId: string, destination: 'files' | 'trash' = 'files') {
    setError('');
    setSearch('');
    setSearchInput('');
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
    if (files.length && !active && !search && view === 'files') setSelected(files);
  }

  async function startUpload() {
    const batch = selected;
    setSelected([]);
    setActive(true);
    stopQueue.current = false;
    try { localStorage.setItem('blackbox-importance', importance); } catch { /* Preferences are optional. */ }
    setTransfers(batch.map((file, id) => ({ id, name: file.name, size: file.size, loaded: 0, status: 'Queued' })));
    const update = (id: number, changes: Partial<Transfer>) => setTransfers((current) =>
      current.map((transfer) => transfer.id === id ? { ...transfer, ...changes } : transfer));

    try {
      for (const [id, file] of batch.entries()) {
        if (stopQueue.current) {
          update(id, { status: 'Cancelled' });
          continue;
        }
        update(id, { status: 'Uploading' });
        const operation = uploadFile(file, parentId, importance, (loaded, verifying) => {
          update(id, { loaded: Math.min(loaded, file.size), status: verifying ? 'Verifying' : 'Uploading' });
        });
        activeUpload.current = operation.cancel;
        try {
          await operation.result;
          update(id, { loaded: file.size, status: 'Completed' });
        } catch (failure) {
          const cancelled = (failure as Error).name === 'AbortError';
          update(id, { status: cancelled ? 'Cancelled' : (failure as Error).message, error: !cancelled });
        }
      }
    } finally {
      activeUpload.current = null;
      setActive(false);
      refresh();
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
  const title = view === 'trash' ? 'Recycle bin' : search ? 'Search results' : 'My files';

  return <div className="workspace">
    <aside className="sidebar">
      <Brand />
      <nav aria-label="Drive">
        <button className={view === 'files' ? 'nav active' : 'nav'} onClick={() => navigate(ROOT_ID)}>
          <Folder size={18} /> My files
        </button>
        <button className={view === 'trash' ? 'nav active' : 'nav'} onClick={() => navigate(ROOT_ID, 'trash')}>
          <Trash2 size={18} /> Recycle bin
        </button>
      </nav>
      <div className="sidebar-bottom">
        <div className="storage-label"><HardDrive size={16} /><span>Local storage</span></div>
        <button className="nav sign-out" onClick={() => void signOut()}><LogOut size={17} /> Sign out</button>
      </div>
    </aside>

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
        <div className="page-title">
          <div><h1>{title}</h1>{search && <p>Results for “{search}”</p>}</div>
          {canUpload && <div className="actions">
            <button onClick={() => setEdit({ action: 'new' })}><FolderPlus size={17} /> New folder</button>
            <button className="primary" disabled={active} onClick={() => fileInput.current?.click()}><Upload size={17} /> Upload</button>
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
              <select aria-label="Sort files" value={sort} onChange={(event) => {
                setSort(event.target.value as Sort); setOffset(0);
              }}>
                <option value="name">Name</option><option value="updated">Recently changed</option><option value="size">Largest first</option>
              </select>
              <div className="toggle">
                <button className="icon" aria-label="List view" aria-pressed={!grid} onClick={() => setGrid(false)}><List size={17} /></button>
                <button className="icon" aria-label="Grid view" aria-pressed={grid} onClick={() => setGrid(true)}><Grid2X2 size={16} /></button>
              </div>
            </div>
          </div>

          {error && <p role="alert" className="banner error">{error} <button onClick={refresh}>Refresh</button></p>}
          {!listing ? (!error && <div className="empty" role="status">Loading files…</div>) : listing.items.length === 0 ?
            <div className="empty">
              {view === 'trash' ? <Archive size={34} /> : search ? <Search size={34} /> : <Folder size={34} />}
              <strong>{view === 'trash' ? 'The recycle bin is empty' : search ? 'No matching files' : 'This folder is empty'}</strong>
              {canUpload && <span>Drop files here or choose Upload.</span>}
            </div> : <>
              {!grid && <div className="file-row table-heading"><span>Name</span><span>Importance</span><span>Size</span><span>Modified</span><span /></div>}
              <ul className={grid ? 'file-grid' : 'file-list'}>
                {listing.items.map((entry) => <FileRow key={entry.id} entry={entry} grid={grid} trash={view === 'trash'}
                  open={() => navigate(entry.id)} onEdit={(action) => setEdit({ action, entry })} restore={() => void restore(entry)} />)}
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
            {active ? <button onClick={() => { stopQueue.current = true; activeUpload.current?.(); }}>Cancel uploads</button>
              : <button onClick={() => setTransfers([])}>Clear</button>}
          </header>
          <ul aria-live="polite">{transfers.map((transfer) => <li key={transfer.id}>
            <span className="file-name">{transfer.name}</span>
            <progress aria-label={'Upload progress for ' + transfer.name} max={Math.max(transfer.size, 1)}
              value={transfer.status === 'Completed' ? Math.max(transfer.size, 1) : transfer.loaded} />
            <span className={transfer.error ? 'error' : 'muted'}>{transfer.status}</span>
          </li>)}</ul>
        </section>}
      </div>
    </main>

    {selected.length > 0 && <Modal title={selected.length === 1 ? 'Upload file' : 'Upload files'} close={() => setSelected([])}>
      <form onSubmit={(event) => { event.preventDefault(); void startUpload(); }}>
        <ul className="upload-files">{selected.map((file, index) => <li key={index}><span>{file.name}</span><span>{formatSize(file.size)}</span></li>)}</ul>
        <ImportanceField value={importance} change={setImportance} />
        <p className="muted">Destination: Local storage</p>
        {importance === 'highly-important' && <p className="warning">This file will have one copy. An independent verified copy is required for full protection.</p>}
        <footer className="modal-actions"><button type="button" onClick={() => setSelected([])}>Cancel</button><button className="primary">Start upload</button></footer>
      </form>
    </Modal>}

    {edit && <EntryDialog edit={edit} parentId={parentId} close={() => setEdit(null)} success={refresh} />}
  </div>;
}

function FileRow({ entry, grid, trash, open, onEdit, restore }: {
  entry: Entry; grid: boolean; trash: boolean; open: () => void; onEdit: (action: Edit['action']) => void; restore: () => void;
}) {
  const folder = entry.kind === 'folder';
  const download = '/api/files/' + entry.id + '/download';
  const icon = folder ? <Folder size={grid ? 28 : 18} /> : <FileIcon size={grid ? 28 : 18} />;
  return <li className={grid ? 'file-tile' : 'file-row'}>
    <div className="entry-name">
      <span className={folder ? 'entry-icon folder' : 'entry-icon'}>{icon}</span>
      {trash ? <span className="file-name">{entry.name}</span> : folder ?
        <button className="text-button file-name" title={entry.name} onClick={open}>{entry.name}</button> :
        <a className="file-name" title={entry.name} href={download}>{entry.name}</a>}
    </div>
    <span className="entry-priority">{entry.deletionPending ? <span className="priority degraded">Deletion pending</span> :
      entry.importance && <span className={entry.protection === 'degraded' ? 'priority degraded' : 'priority'}
      title={entry.protection === 'degraded' ? 'Only one verified copy' : undefined}>{labels[entry.importance]}</span>}</span>
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
  const needsName = ['new', 'rename', 'copy'].includes(action);
  const hasDestination = action === 'move' || action === 'copy';

  async function save(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError('');
    const path = '/entries/' + entry?.id;
    try {
      if (action === 'new') await api('/folders', { method: 'POST', body: JSON.stringify({ name, parentId }) });
      else if (action === 'trash') await api(path, { method: 'DELETE' });
      else if (action === 'purge') await api(path + '/permanent', { method: 'DELETE' });
      else if (action === 'copy') await api(path + '/copy', { method: 'POST', body: JSON.stringify({ name, parentId: destination }) });
      else {
        const changes = action === 'rename' ? { name } : action === 'move' ? { parentId: destination } : { importance };
        await api(path, { method: 'PATCH', body: JSON.stringify(changes) });
      }
      success();
      close();
    } catch (failure) {
      setError((failure as Error).message);
      if (action === 'purge') success();
      setBusy(false);
    }
  }

  return <Modal title={titles[action]} close={() => { if (!busy) close(); }}>
    <form onSubmit={save}>
      {action === 'trash' && <p>Move <strong>{entry?.name}</strong> to the recycle bin?</p>}
      {action === 'purge' && <p>Permanently delete <strong>{entry?.name}</strong>
        {entry?.kind === 'folder' ? ' and everything inside it' : ''}? This cannot be undone.</p>}
      {needsName && <label className="field">Name<input value={name} maxLength={180} required autoFocus
        onChange={(event) => setName(event.target.value)} /></label>}
      {hasDestination && <FolderPicker folder={destination} change={setDestination} excluded={action === 'move' ? entry?.id : undefined} />}
      {action === 'importance' && <ImportanceField value={importance} change={setImportance} />}
      {error && <p className="error" role="alert">{error}</p>}
      <footer className="modal-actions"><button type="button" autoFocus={action === 'purge'} disabled={busy} onClick={close}>Cancel</button>
        <button className={action === 'purge' ? 'danger' : 'primary'} disabled={busy}>
          {busy ? (action === 'purge' ? 'Deleting…' : 'Saving…') :
            (action === 'trash' || action === 'purge' ? titles[action] : 'Save')}
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
