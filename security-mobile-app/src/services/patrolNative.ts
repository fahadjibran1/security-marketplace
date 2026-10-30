// The device side of Patrols on the Guard's phone (Patrols P1-E): the ONLY module that touches SQLite, the file system,
// the image manipulator and the crypto digest for patrols. Everything it does is plugged into the pure modules in
// src/components/guard/patrol/ (which the spec executes) through their ports.
//
// Storage choices (see docs/patrols/P1-E-guard-app.md):
//   * the outbox is the SQLite database `s4-patrol-outbox.db` in the app's private data (expo-sqlite's default
//     directory) — not the cache, not shared storage;
//   * evidence files live in `<document directory>/patrol-evidence/u<userId>/` — app-private, never the cache (which the
//     OS may purge), never the photo library or shared media, and namespaced per signed-in user;
//   * both are kept out of device backups and device-to-device transfer by plugins/withPatrolBackupExclusion.js
//     (Android backup rules; iOS NSURLIsExcludedFromBackupKey on Documents/patrol-evidence and Documents/SQLite);
//   * stale camera / re-encode temporaries in the cache are swept by patrolTempNative.ts (never patrol-evidence/);
//   * nothing here asks for location, the photo library or background execution.

import * as Crypto from 'expo-crypto';
import { Directory, File, Paths } from 'expo-file-system';
import { FileSystemSessionType, FileSystemUploadType, uploadAsync } from 'expo-file-system/legacy';
import { ImageManipulator, SaveFormat } from 'expo-image-manipulator';
import { openDatabaseAsync } from 'expo-sqlite';
import type { EvidenceFiles, PresignedUpload } from '../components/guard/patrol/patrolOutbox';
import type { PhotoPorts } from '../components/guard/patrol/patrolImage';
import { SqlOutboxStore, type SqlDb } from '../components/guard/patrol/patrolOutboxSql';

const DATABASE_NAME = 's4-patrol-outbox.db';
const EVIDENCE_ROOT = 'patrol-evidence';

let database: Promise<SqlDb> | null = null;

/** The outbox store, opened once per app process. */
export function patrolOutboxStore(): SqlOutboxStore {
  if (!database) {
    database = openDatabaseAsync(DATABASE_NAME).then((db) => db as unknown as SqlDb);
  }
  const lazy: SqlDb = {
    execAsync: async (source) => (await database!).execAsync(source),
    runAsync: async (source, params) => (await database!).runAsync(source, params),
    getAllAsync: async <T,>(source: string, params: Array<string | number | null>) => (await database!).getAllAsync<T>(source, params),
  };
  return new SqlOutboxStore(lazy);
}

function evidenceDirectory(ownerUserId: number): Directory {
  if (!Number.isInteger(ownerUserId) || ownerUserId <= 0) throw new Error('No signed-in Guard.');
  return new Directory(Paths.document, EVIDENCE_ROOT, `u${ownerUserId}`);
}

/** This Guard's private evidence folder: only paths inside it are ever read, sent or deleted for them. */
export function evidenceFilesFor(ownerUserId: number): EvidenceFiles {
  const root = evidenceDirectory(ownerUserId).uri.replace(/\/?$/, '/');
  return {
    owns: (path) => typeof path === 'string' && path.startsWith(root) && !path.slice(root.length).includes('..'),
    exists: async (path) => new File(path).exists,
    remove: async (path) => {
      if (!path.startsWith(root)) return;
      const file = new File(path);
      if (file.exists) file.delete();
    },
  };
}

export function photoPortsFor(ownerUserId: number): PhotoPorts {
  const directory = evidenceDirectory(ownerUserId);
  return {
    readBytes: async (uri) => new File(uri).bytes(),
    reencodeJpeg: async (uri, { maxEdge, quality, width, height }) => {
      const context = ImageManipulator.manipulate(uri);
      if (Math.max(width, height) > maxEdge) context.resize(width >= height ? { width: maxEdge } : { height: maxEdge });
      const image = await context.renderAsync();
      const saved = await image.saveAsync({ format: SaveFormat.JPEG, compress: quality, base64: false });
      return { uri: saved.uri, width: saved.width, height: saved.height };
    },
    sha256: async (bytes) => new Uint8Array(await Crypto.digest(Crypto.CryptoDigestAlgorithm.SHA256, new Uint8Array(bytes))),
    writeEvidence: async (fileName, bytes) => {
      if (!/^[A-Za-z0-9_-]{8,64}\.jpg$/.test(fileName)) throw new Error('bad evidence file name');
      if (!directory.exists) directory.create({ intermediates: true, idempotent: true });
      const file = new File(directory, fileName);
      if (file.exists) file.delete();
      file.create();
      file.write(bytes);
      return file.uri;
    },
    removeFile: async (uri) => {
      const file = new File(uri);
      if (file.exists) file.delete();
    },
    freeBytes: () => {
      try {
        const free = Paths.availableDiskSpace;
        return Number.isFinite(free) && free > 0 ? free : null;
      } catch {
        return null;
      }
    },
  };
}

/**
 * The presigned PUT: the file's exact bytes, with exactly the headers the server signed (Content-Type and, when
 * configured, x-amz-checksum-sha256; Content-Length is set from the file). No S4 Authorization header is ever sent to
 * storage, and the URL is neither logged nor stored.
 */
export async function putEvidenceObject(upload: PresignedUpload, filePath: string): Promise<{ status: number }> {
  const result = await uploadAsync(upload.url, filePath, {
    httpMethod: 'PUT',
    uploadType: FileSystemUploadType.BINARY_CONTENT,
    headers: upload.headers,
    sessionType: FileSystemSessionType.FOREGROUND,
  });
  return { status: result.status };
}

/** A client id the backend accepts (8–64 of A–Z a–z 0–9 _ -): a random UUID. */
export function newPatrolClientId(): string {
  return Crypto.randomUUID();
}
