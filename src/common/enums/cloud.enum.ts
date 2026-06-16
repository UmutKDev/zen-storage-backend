enum Role {
  ADMIN = 'ADMIN',
  USER = 'USER',
}

enum Status {
  ACTIVE = 'ACTIVE',
  INACTIVE = 'INACTIVE',
  PENDING = 'PENDING',
  SUSPENDED = 'SUSPENDED',
  APPROVAL = 'APPROVAL',
}

enum Theme {
  LIGHT = 'LIGHT',
  DARK = 'DARK',
  COLORFUL = 'COLORFUL',
  SIMPLE = 'SIMPLE',
}

enum UUID {
  EMPTY = '00000000-0000-0000-0000-000000000000',
}

enum UploadSessionStatus {
  ACTIVE = 'ACTIVE',
  COMPLETED = 'COMPLETED',
  ABORTED = 'ABORTED',
}

enum CloudContextLevel {
  ROOT = 'ROOT',
  SUBFOLDER = 'SUBFOLDER',
}

enum CloudDirectoryType {
  FOLDER = 'FOLDER',
}

enum CloudBreadcrumbLevelType {
  ROOT = 'ROOT',
  SUBFOLDER = 'SUBFOLDER',
}

enum ArchiveJobState {
  WAITING = 'waiting',
  DELAYED = 'delayed',
  ACTIVE = 'active',
  COMPLETED = 'completed',
  FAILED = 'failed',
}

enum ArchivePhase {
  EXTRACT = 'extract',
  CREATE = 'create',
}

enum ArchiveFormat {
  ZIP = 'zip',
  TAR = 'tar',
  TAR_GZ = 'tar.gz',
  RAR = 'rar',
}

enum ArchiveEntryType {
  FILE = 'file',
  DIRECTORY = 'directory',
}

enum ConflictResolutionStrategy {
  FAIL = 'FAIL',
  REPLACE = 'REPLACE',
  SKIP = 'SKIP',
  KEEP_BOTH = 'KEEP_BOTH',
}

enum DuplicateScanStatus {
  PENDING = 'PENDING',
  SCANNING = 'SCANNING',
  COMPLETED = 'COMPLETED',
  CANCELLED = 'CANCELLED',
  FAILED = 'FAILED',
}

enum DuplicateScanPhase {
  LISTING = 'LISTING',
  SIZE_GROUPING = 'SIZE_GROUPING',
  CONTENT_HASHING = 'CONTENT_HASHING',
  PERCEPTUAL_HASHING = 'PERCEPTUAL_HASHING',
  FINALIZING = 'FINALIZING',
}

export {
  Role,
  Status,
  Theme,
  UUID,
  UploadSessionStatus,
  CloudContextLevel,
  CloudDirectoryType,
  CloudBreadcrumbLevelType,
  ArchiveJobState,
  ArchivePhase,
  ArchiveFormat,
  ArchiveEntryType,
  ConflictResolutionStrategy,
  DuplicateScanStatus,
  DuplicateScanPhase,
};
