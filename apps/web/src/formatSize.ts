export function formatSize(bytes: number) {
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let index = 0;
  while (bytes >= 1024 && index < units.length - 1) {
    bytes /= 1024;
    index++;
  }
  return new Intl.NumberFormat(undefined, { maximumFractionDigits: index ? 1 : 0 }).format(bytes) + ' ' + units[index];
}
