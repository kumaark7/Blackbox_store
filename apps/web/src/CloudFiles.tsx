import { useEffect, useRef, useState } from 'react';
import { ArrowDownToLine, ChevronRight, ExternalLink, File, Folder, Grid2X2, List, Search, Upload } from 'lucide-react';
import { api } from './api';
import { formatSize } from './formatSize';
import { Workspace } from './Workspace';
import { FileLoading } from './FileLoading';

export const cloudFileProviders = { google: 'Google Drive', mega: 'MEGA' } as const;
type Provider = keyof typeof cloudFileProviders;
type FolderLocation = { id: string; name: string };
type CloudEntry = FolderLocation & { folder: boolean; size: number | null; openUrl?: string };
type Listing = { items: CloudEntry[]; next?: string };

export function FileSources({ active }: { active?: Provider }) {
  return <nav className="file-sources" aria-label="File locations">
    <a href="/drive" aria-current={active ? undefined : 'page'}>Blackbox files</a>
    {Object.entries(cloudFileProviders).map(([id, name]) => <a key={id} href={'/drive?cloud=' + id}
      aria-current={active === id ? 'page' : undefined}>{name}</a>)}
  </nav>;
}

export function CloudFiles({ provider, onLogout }: { provider: Provider; onLogout: () => void }) {
  const name = cloudFileProviders[provider];
  const endpoint = '/cloud/' + provider;
  const input = useRef<HTMLInputElement>(null);
  const [trail, setTrail] = useState<FolderLocation[]>([]);
  const [listing, setListing] = useState<Listing | null>(null);
  const [revision, setRevision] = useState(0);
  const [error, setError] = useState('');
  const [uploadError, setUploadError] = useState('');
  const [uploading, setUploading] = useState('');
  const [paging, setPaging] = useState(false);
  const [query, setQuery] = useState('');
  const [sort, setSort] = useState<'name' | 'size'>('name');
  const [grid, setGrid] = useState(() => {
    try { return localStorage.getItem('blackbox-files-view') === 'grid'; }
    catch { return false; }
  });
  const folder = trail.at(-1);
  const parent = folder?.id;

  useEffect(() => {
    const controller = new AbortController();
    void api<Listing>(endpoint + '/files?' + new URLSearchParams(parent === undefined ? {} : { parent }),
      { signal: controller.signal }).then((result) => {
        if (!controller.signal.aborted) setListing(result);
      }).catch((failure: Error) => {
        if (!controller.signal.aborted) setError(failure.message);
      });
    return () => controller.abort();
  }, [endpoint, parent, revision]);

  function navigate(next: FolderLocation[]) {
    setListing(null);
    setError('');
    setUploadError('');
    setQuery('');
    setTrail(next);
  }

  async function loadMore() {
    if (!listing?.next || paging) return;
    setPaging(true);
    setError('');
    try {
      const query = new URLSearchParams({ cursor: listing.next });
      if (parent !== undefined) query.set('parent', parent);
      const page = await api<Listing>(endpoint + '/files?' + query);
      setListing({ ...page, items: [...listing.items, ...page.items] });
    } catch (failure) {
      setError((failure as Error).message);
    } finally {
      setPaging(false);
    }
  }

  async function upload(files: File[]) {
    if (!files.length || uploading) return;
    setUploadError('');
    const failed: string[] = [];
    for (const file of files) {
      setUploading(file.name);
      const query = new URLSearchParams({ name: file.name });
      if (parent !== undefined) query.set('parent', parent);
      if (/^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/i.test(file.type)) query.set('mime', file.type);
      try {
        await api(endpoint + '/uploads?' + query, { method: 'POST', body: file,
          headers: { 'Content-Type': 'application/octet-stream' } });
      } catch (failure) {
        failed.push(file.name + '. ' + (failure as Error).message);
      }
    }
    setUploading('');
    setUploadError(failed.join('\n'));
    setError('');
    setRevision((value) => value + 1);
  }

  const busy = paging || Boolean(uploading);
  const filter = query.trim().toLocaleLowerCase();
  const visible = listing?.items.filter(({ name }) => name.toLocaleLowerCase().includes(filter))
    .sort((a, b) => Number(b.folder) - Number(a.folder)
      || (sort === 'size' ? (b.size ?? -1) - (a.size ?? -1) : 0) || a.name.localeCompare(b.name)) ?? [];
  function selectView(value: boolean) {
    setGrid(value);
    try { localStorage.setItem('blackbox-files-view', value ? 'grid' : 'list'); }
    catch { /* Preferences are optional. */ }
  }
  return <Workspace onSignOut={() => void api('/auth/logout', { method: 'POST' }).then(onLogout).catch((failure: Error) => setError(failure.message))}
    filesNavigation={<a className="nav active" href="/drive" aria-current="location"><Folder size={18} /> My Files</a>}>
    <main className="main"><div className="content">
      <FileSources active={provider} />
      <div className="page-title">
        <h1>{folder?.name ?? name}</h1>
        {listing && parent !== '@shared' && <>
          <button className="primary" disabled={busy} onClick={() => input.current?.click()}><Upload size={17} /> Upload</button>
          <input ref={input} type="file" multiple hidden onChange={(event) => {
            const files = Array.from(event.currentTarget.files ?? []);
            event.currentTarget.value = '';
            void upload(files);
          }} />
        </>}
      </div>
      {uploading && <p role="status">Uploading {uploading}</p>}
      {uploadError && <p className="error cloud-upload-error" role="alert">{uploadError}</p>}
      {error && <div className="banner"><span role="alert">{error}</span>
        <a href="/connections">Account connections</a></div>}
      {!listing && !error && <FileLoading />}
      {listing && <section className="file-panel" aria-label={name + ' files'}>
        <div className="panel-top">
          <nav className="breadcrumbs" aria-label="Folder path">
            {[{ id: '', name }, ...trail].map((crumb, index) => <span key={crumb.id}>
              {index > 0 && <ChevronRight size={13} aria-hidden="true" />}
              {index === trail.length ? <span aria-current="location">{crumb.name}</span>
                : <button disabled={busy} onClick={() => navigate(trail.slice(0, index))}>{crumb.name}</button>}
            </span>)}
          </nav>
          <div className="panel-actions">
            <label className="search native-search"><Search size={16} aria-hidden="true" />
              <input type="search" aria-label="Search loaded cloud files" placeholder="Search loaded files" maxLength={180}
                value={query} onChange={(event) => setQuery(event.currentTarget.value)} />
            </label>
            <select aria-label="Sort loaded cloud files" value={sort} onChange={(event) => setSort(event.currentTarget.value as typeof sort)}>
              <option value="name">Name</option><option value="size">Largest first</option>
            </select>
            <div className="toggle">
              <button className="icon" aria-label="List view" aria-pressed={!grid} onClick={() => selectView(false)}><List size={17} /></button>
              <button className="icon" aria-label="Grid view" aria-pressed={grid} onClick={() => selectView(true)}><Grid2X2 size={16} /></button>
            </div>
          </div>
        </div>
        {visible.length ? <ul className={grid ? 'file-grid native-file-grid' : 'cloud-file-list'}>
          {visible.map((entry, index) => <li key={entry.id + ':' + index} className={grid ? 'file-tile' : undefined}>
            {entry.folder ? <div className="entry-name">
              <span className="entry-icon folder"><Folder size={grid ? 28 : 18} aria-hidden="true" /></span>
              <button className="text-button file-name" title={entry.name} disabled={busy}
                onClick={() => navigate([...trail, entry])}>{entry.name}</button>
            </div> : <>
              <div className="entry-name">
                <span className="entry-icon"><File size={grid ? 28 : 18} aria-hidden="true" /></span>
                <a className="file-name" title={entry.name}
                  href={entry.openUrl ?? '/api' + endpoint + '/download?' + new URLSearchParams({ id: entry.id })}
                  target={entry.openUrl ? '_blank' : undefined} rel={entry.openUrl ? 'noopener noreferrer' : undefined}>{entry.name}</a>
              </div>
              <span className="cloud-file-size">{entry.size === null ? '' : formatSize(entry.size)}
                {entry.openUrl ? <ExternalLink size={15} aria-hidden="true" /> : <ArrowDownToLine size={15} aria-hidden="true" />}</span>
            </>}
          </li>)}
        </ul> : <p className="empty">{filter ? 'No matching loaded files.' : 'This folder is empty.'}</p>}
        {listing.next && <div className="paging"><button disabled={busy} onClick={() => void loadMore()}>
          {paging ? 'Loading files' : 'Load more'}
        </button></div>}
      </section>}
    </div></main>
  </Workspace>;
}
