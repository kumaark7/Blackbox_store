import { Box } from 'lucide-react';

export function Brand({ href }: { href?: string }) {
  const content = <>
    <span className="brand-mark"><Box size={28} strokeWidth={1.8} aria-hidden="true" /></span>
    <span><strong>Blackbox Store</strong><small>Personal Cloud Drive</small></span>
  </>;
  return href ? <a className="brand" href={href}>{content}</a> : <div className="brand">{content}</div>;
}
