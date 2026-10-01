import type { Readable } from 'node:stream';

export const MAX_TEXT_FILE_BYTES = 32 * 1_024;
export const MAX_TEXT_FILE_BASE64_CHARS = 4 * Math.ceil(MAX_TEXT_FILE_BYTES / 3);
export const SUPPORTED_TEXT_CONTENT_TYPES = ['text/plain', 'text/csv'] as const;
export type SupportedTextContentType = (typeof SUPPORTED_TEXT_CONTENT_TYPES)[number];
export type SupportedFileKind = 'TXT' | 'CSV' | 'DOCX' | 'XLSX' | 'PPTX' | 'IMAGE' | 'AUDIO' | 'VIDEO' | 'ZIP' | 'CODE';

export interface StoredObject {
  key: string;
  contentType: string;
  byteLength: number;
  sha256: string;
}

/** Future S3-compatible storage port; current small-text files use encrypted PostgreSQL records. */
export interface ObjectStorage {
  put(input: { key: string; body: Readable; contentType: string; byteLength: number; sha256: string }): Promise<StoredObject>;
  get(key: string): Promise<Readable>;
  delete(key: string): Promise<void>;
}

export interface ParsedFileContent {
  kind: 'TXT' | 'CSV';
  text: string;
  metadata: Record<string, unknown>;
}

/** Implemented parser scope is UTF-8 TXT/Markdown/log and CSV only; archives and office formats stay disabled. */
export interface FileParser {
  supports(contentType: string, filename: string): boolean;
  parse(input: { stream: Readable; contentType: string; filename: string; maxBytes: number }): Promise<ParsedFileContent>;
}

export interface FileMetadata {
  fileId: string;
  filename: string;
  contentType: SupportedTextContentType;
  byteLength: number;
  sha256: string;
  createdAt: string;
}

export interface AnalyzableFileContent extends FileMetadata {
  kind: 'TXT' | 'CSV';
  text: string;
  extractorVersion: string;
  parsedPages: number;
  excerpt: string;
}

export interface FileUploadInput {
  filename: string;
  contentType: SupportedTextContentType;
  contentBase64: string;
}

export interface FileService {
  isReady(): Promise<boolean>;
  createUpload(input: { userId: string } & FileUploadInput): Promise<FileMetadata>;
  getMetadata(input: { userId: string; fileId: string }): Promise<FileMetadata>;
  parseForAnalysis(input: { userId: string; fileId: string }): Promise<AnalyzableFileContent>;
  delete(input: { userId: string; fileId: string }): Promise<boolean>;
}

export interface EncryptedFileRecord extends FileMetadata {
  userId: string;
  keyVersion: number;
  ciphertext: Buffer;
  nonce: Buffer;
  authTag: Buffer;
  wrappedKey: Buffer;
  wrapNonce: Buffer;
  wrapAuthTag: Buffer;
}

/** Stores opaque ciphertext and writes matching upload/delete audit records atomically. */
export interface FileRepository {
  createFile(input: Omit<EncryptedFileRecord, 'createdAt'>): Promise<FileMetadata>;
  findFileForOwner(fileId: string, userId: string): Promise<EncryptedFileRecord | null>;
  deleteFileForOwner(fileId: string, userId: string): Promise<boolean>;
}
