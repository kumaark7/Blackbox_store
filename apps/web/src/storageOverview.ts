import type { StorageUsage } from './api';

export function storageOverview(cloud: StorageUsage['cloud']) {
  const accounts = cloud.accounts.filter(({ status }) => status === 'connected' || status === 'retrying');
  const capacityAccounts = accounts.filter(({ id }) => id !== 'telegram');
  const reported = capacityAccounts.flatMap(({ quota }) => quota && quota.totalBytes !== null
    ? [{ used: quota.usedBytes, total: quota.totalBytes }] : []);
  const used = reported.reduce((sum, quota) => sum + quota.used, 0);
  const total = reported.reduce((sum, quota) => sum + quota.total, 0);
  return { accounts, used, total, free: Math.max(0, total - used),
    percentage: total > 0 ? used / total * 100 : null,
    reported: reported.length, eligible: capacityAccounts.length };
}
