export function FileLoading() {
  return <div className="files-skeleton" role="status">
    <span className="sr-only">Loading files</span>
    {[1, 2, 3, 4].map((item) => <i key={item} className="skeleton" aria-hidden="true" />)}
  </div>;
}
