export class DriveError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export class TeraboxCleanupRequired extends DriveError {
  readonly paths: string[];
  readonly confirmation: string;

  constructor(paths: string[], confirmation: string) {
    super(409, 'Clear these copies from the TeraBox Recycle Bin before finishing deletion.');
    this.paths = paths;
    this.confirmation = confirmation;
  }
}
