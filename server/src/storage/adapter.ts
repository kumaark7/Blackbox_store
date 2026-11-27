import type { Readable } from 'node:stream';
import type { AccountQuota } from './quota.ts';

export type StoredObject = { key: string; size: number; sha256: string; format: 0 | 1 };
export type Ciphertext = { key: string; bytes: number; checksum: string };

export type NativeEntry = { id: string; name: string; folder: boolean; size: number | null; openUrl?: string };
export type NativeListing = { items: NativeEntry[]; next?: string };
export interface NativeCloud {
  listFiles(parent: string, cursor: string | undefined, signal: AbortSignal): Promise<NativeListing>;
  downloadFile(id: string, signal: AbortSignal): Promise<{ name: string; stream: Readable }>;
  uploadFile(parent: string, name: string, mime: string, path: string, bytes: number, signal: AbortSignal): Promise<void>;
}

export interface CloudProvider {
  native?: NativeCloud;
  allocate(signal: AbortSignal, key: string): Promise<string>;
  upload(id: string, object: Ciphertext, sourcePath: string, signal: AbortSignal): Promise<void>;
  verify(id: string, object: Ciphertext, signal: AbortSignal): Promise<boolean>;
  download(id: string, signal: AbortSignal, bytes: number): Promise<Readable>;
  delete(id: string, signal: AbortSignal): Promise<void | { path: string; moved: boolean }>;
  quota?(signal: AbortSignal): Promise<AccountQuota | null>;
  close?(): Promise<void>;
}

export interface StorageAdapter {
  readonly capabilities: {
    maxObjectBytes: number;
    quota: boolean;
    rangeRead: boolean;
    resumableUpload: boolean;
    deletion: boolean;
    integrityVerification: boolean;
  };
  upload(key: string, source: Readable, signal?: AbortSignal): Promise<StoredObject>;
  download(object: StoredObject): Promise<Readable>;
  delete(key: string): Promise<void>;
  verify(object: StoredObject, signal?: AbortSignal): Promise<boolean>;
}
