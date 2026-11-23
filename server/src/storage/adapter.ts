import type { Readable } from 'node:stream';

export type StoredObject = { key: string; size: number; sha256: string };

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
