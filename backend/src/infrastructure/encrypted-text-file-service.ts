import { createCipheriv, createDecipheriv, createHash, randomBytes, randomUUID } from 'node:crypto';
import { Readable } from 'node:stream';
import {
  MAX_TEXT_FILE_BASE64_CHARS,
  MAX_TEXT_FILE_BYTES,
  type EncryptedFileRecord,
  type FileMetadata,
  type FileParser,
  type FileRepository,
  type FileService,
  type FileUploadInput,
} from '../application/file-ports.js';
import { HttpError } from '../domain/errors.js';
import { Utf8TextFileParser } from './utf8-file-parser.js';

interface SealedBytes { ciphertext: Buffer; nonce: Buffer; authTag: Buffer }

function seal(plaintext: Buffer, key: Buffer, aad: string): SealedBytes {
  const nonce = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, nonce);
  cipher.setAAD(Buffer.from(aad, 'utf8'));
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return { ciphertext, nonce, authTag: cipher.getAuthTag() };
}

function open(sealed: { ciphertext: Buffer; nonce: Buffer; authTag: Buffer }, key: Buffer, aad: string): Buffer {
  const decipher = createDecipheriv('aes-256-gcm', key, sealed.nonce);
  decipher.setAAD(Buffer.from(aad, 'utf8'));
  decipher.setAuthTag(sealed.authTag);
  return Buffer.concat([decipher.update(sealed.ciphertext), decipher.final()]);
}

function fileAad(record: Pick<EncryptedFileRecord, 'fileId' | 'userId' | 'filename' | 'contentType' | 'byteLength' | 'sha256'>): string {
  return JSON.stringify(['file-v1', record.fileId, record.userId, record.filename, record.contentType, record.byteLength, record.sha256]);
}

function wrapAad(record: Pick<EncryptedFileRecord, 'fileId' | 'userId'>): string {
  return JSON.stringify(['file-key-v1', record.fileId, record.userId]);
}

function validateFilename(filename: string, contentType: FileUploadInput['contentType']): string {
  const normalized = filename.trim().normalize('NFC');
  if (!normalized || Buffer.byteLength(normalized, 'utf8') > 255 || /[\\/\u0000-\u001F\u007F]/u.test(normalized) || normalized === '.' || normalized === '..') {
    throw new HttpError(400, 'INVALID_FILENAME', 'The filename is invalid.');
  }
  const extension = normalized.slice(normalized.lastIndexOf('.')).toLowerCase();
  const supported = contentType === 'text/csv'
    ? extension === '.csv'
    : ['.txt', '.md', '.log'].includes(extension);
  if (!supported) throw new HttpError(415, 'UNSUPPORTED_FILE_TYPE', 'Only UTF-8 text, Markdown, log, and CSV files are supported.');
  return normalized;
}

function decodeCanonicalBase64(value: string): Buffer {
  if (!value || value.length > MAX_TEXT_FILE_BASE64_CHARS || value.length % 4 !== 0 ||
      !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(value)) {
    throw new HttpError(400, 'INVALID_FILE_ENCODING', 'The uploaded content must be canonical base64.');
  }
  const bytes = Buffer.from(value, 'base64');
  if (bytes.toString('base64') !== value) throw new HttpError(400, 'INVALID_FILE_ENCODING', 'The uploaded content must be canonical base64.');
  if (bytes.length > MAX_TEXT_FILE_BYTES) throw new HttpError(413, 'FILE_TOO_LARGE', 'The text file exceeds the 32 KiB limit.');
  return bytes;
}

function metadataOnly(record: EncryptedFileRecord): FileMetadata {
  return {
    fileId: record.fileId,
    filename: record.filename,
    contentType: record.contentType,
    byteLength: record.byteLength,
    sha256: record.sha256,
    createdAt: record.createdAt,
  };
}

/**
 * Small UTF-8 text/CSV storage with per-file AES-256-GCM data keys wrapped by an operator key.
 * Only ciphertext and wrapped data keys are persisted; raw content is never logged or returned by upload.
 */
export class EncryptedTextFileService implements FileService {
  private readonly masterKey: Buffer | null;

  constructor(
    private readonly repository: FileRepository,
    keyHex: string | undefined,
    private readonly parser: FileParser = new Utf8TextFileParser(),
  ) {
    if (keyHex && !/^[a-fA-F0-9]{64}$/u.test(keyHex)) throw new Error('FILE_ENCRYPTION_KEY must be exactly 32 bytes encoded as 64 hexadecimal characters.');
    this.masterKey = keyHex ? Buffer.from(keyHex, 'hex') : null;
  }

  async isReady(): Promise<boolean> { return this.masterKey !== null; }

  async createUpload(input: { userId: string } & FileUploadInput): Promise<FileMetadata> {
    const masterKey = this.requireKey();
    const filename = validateFilename(input.filename, input.contentType);
    const bytes = decodeCanonicalBase64(input.contentBase64);
    if (bytes.length === 0) throw new HttpError(400, 'EMPTY_FILE_CONTENT', 'The text file must contain readable content.');

    // Validate content and format before persisting; the same parser is used by the worker.
    await this.parser.parse({ stream: Readable.from([bytes]), contentType: input.contentType, filename, maxBytes: MAX_TEXT_FILE_BYTES });
    const fileId = randomUUID();
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    const recordIdentity = {
      fileId,
      userId: input.userId,
      filename,
      contentType: input.contentType,
      byteLength: bytes.length,
      sha256,
      keyVersion: 1,
    } as const;
    const dataKey = randomBytes(32);
    let content: SealedBytes;
    let wrapped: SealedBytes;
    try {
      content = seal(bytes, dataKey, fileAad(recordIdentity));
      wrapped = seal(dataKey, masterKey, wrapAad(recordIdentity));
    } finally {
      dataKey.fill(0);
    }
    return this.repository.createFile({
      ...recordIdentity,
      ciphertext: content.ciphertext,
      nonce: content.nonce,
      authTag: content.authTag,
      wrappedKey: wrapped.ciphertext,
      wrapNonce: wrapped.nonce,
      wrapAuthTag: wrapped.authTag,
    });
  }

  async getMetadata(input: { userId: string; fileId: string }): Promise<FileMetadata> {
    const record = await this.repository.findFileForOwner(input.fileId, input.userId);
    if (!record) throw new HttpError(404, 'FILE_NOT_FOUND', 'The file was not found.');
    return metadataOnly(record);
  }

  async parseForAnalysis(input: { userId: string; fileId: string }) {
    const masterKey = this.requireKey();
    const record = await this.repository.findFileForOwner(input.fileId, input.userId);
    if (!record) throw new HttpError(404, 'FILE_NOT_FOUND', 'The file was not found.');
    if (record.keyVersion !== 1) throw new HttpError(503, 'FILE_CONTENT_UNAVAILABLE', 'The stored file cannot be opened with the configured key version.');

    let plaintext: Buffer;
    let dataKey: Buffer | undefined;
    try {
      dataKey = open(
        { ciphertext: record.wrappedKey, nonce: record.wrapNonce, authTag: record.wrapAuthTag },
        masterKey,
        wrapAad(record),
      );
      if (dataKey.length !== 32) throw new Error('Invalid data key length.');
      plaintext = open(
        { ciphertext: record.ciphertext, nonce: record.nonce, authTag: record.authTag },
        dataKey,
        fileAad(record),
      );
    } catch {
      throw new HttpError(503, 'FILE_INTEGRITY_CHECK_FAILED', 'Stored file integrity could not be verified.');
    } finally {
      dataKey?.fill(0);
    }

    const actualHash = createHash('sha256').update(plaintext).digest('hex');
    if (plaintext.length !== record.byteLength || actualHash !== record.sha256) {
      throw new HttpError(503, 'FILE_INTEGRITY_CHECK_FAILED', 'Stored file integrity could not be verified.');
    }
    const parsed = await this.parser.parse({
      stream: Readable.from([plaintext]),
      contentType: record.contentType,
      filename: record.filename,
      maxBytes: MAX_TEXT_FILE_BYTES,
    });
    const excerpt = parsed.text.trim().slice(0, 1_000);
    return {
      ...metadataOnly(record),
      kind: parsed.kind,
      text: parsed.text,
      extractorVersion: String(parsed.metadata.extractorVersion ?? 'utf8-text-v1'),
      parsedPages: Number(parsed.metadata.parsedPages ?? 1),
      excerpt,
    };
  }

  async delete(input: { userId: string; fileId: string }): Promise<boolean> {
    return this.repository.deleteFileForOwner(input.fileId, input.userId);
  }

  private requireKey(): Buffer {
    if (!this.masterKey) throw new HttpError(501, 'FILE_SERVICE_UNAVAILABLE', 'Encrypted text-file storage is not configured.');
    return this.masterKey;
  }
}
