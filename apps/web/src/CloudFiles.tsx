import { useEffect, useRef, useState } from 'react';
import { ArrowDownToLine, ArrowLeft, ExternalLink, File, Folder, Upload } from 'lucide-react';
import { api } from './api';
import { formatSize } from './formatSize';
import { Workspace } from './Workspace';

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
  return <Workspace onSignOut={() => void api('/auth/logout', { method: 'POST' }).then(onLogout).catch((failure: Error) => setError(failure.message))}
    filesNavigation={<a className="nav active" href="/drive" aria-current="location"><Folder size={18} /> My files</a>}>
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
      {folder && <button className="cloud-back" disabled={busy} onClick={() => navigate(trail.slice(0, -1))}>
        <ArrowLeft size={16} /> {trail.at(-2)?.name ?? name}
      </button>}
      {uploading && <p role="status">Uploading {uploading}</p>}
      {uploadError && <p className="error cloud-upload-error" role="alert">{uploadError}</p>}
      {error && <div className="banner"><span role="alert">{error}</span>
        <a href="/connections">Account connections</a></div>}
      {!listing && !error && <p role="status">Loading files</p>}
      {listing && <section className="file-panel" aria-label={name + ' files'}>
        {listing.items.length ? <ul className="cloud-file-list">
          {listing.items.map((entry, index) => <li key={entry.id + ':' + index}>
            {entry.folder ? <>
              <Folder size={18} aria-hidden="true" />
              <button className="text-button file-name" title={entry.name} disabled={busy}
                onClick={() => navigate([...trail, entry])}>{entry.name}</button>
            </> : <>
              <File size={18} aria-hidden="true" />
              <a className="file-name" title={entry.name}
                href={entry.openUrl ?? '/api' + endpoint + '/download?' + new URLSearchParams({ id: entry.id })}
                target={entry.openUrl ? '_blank' : undefined} rel={entry.openUrl ? 'noopener noreferrer' : undefined}>{entry.name}</a>
              <span className="cloud-file-size">{entry.size === null ? '' : formatSize(entry.size)}
                {entry.openUrl ? <ExternalLink size={15} aria-hidden="true" /> : <ArrowDownToLine size={15} aria-hidden="true" />}</span>
            </>}
          </li>)}
        </ul> : <p className="empty">This folder is empty.</p>}
        {listing.next && <div className="paging"><button disabled={busy} onClick={() => void loadMore()}>
          {paging ? 'Loading files' : 'Load more'}
        </button></div>}
      </section>}
    </div></main>
  </Workspace>;
}
