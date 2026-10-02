import { TextDecoder } from 'node:util';
import type { Readable } from 'node:stream';
import type { FileParser, ParsedFileContent } from '../application/file-ports.js';
import { HttpError } from '../domain/errors.js';

function extension(filename: string): string {
  const dot = filename.lastIndexOf('.');
  return dot < 0 ? '' : filename.slice(dot).toLowerCase();
}

export class Utf8TextFileParser implements FileParser {
  supports(contentType: string, filename: string): boolean {
    const ext = extension(filename);
    return (contentType === 'text/csv' && ext === '.csv') ||
      (contentType === 'text/plain' && ['.txt', '.md', '.log'].includes(ext));
  }

  async parse(input: { stream: Readable; contentType: string; filename: string; maxBytes: number }): Promise<ParsedFileContent> {
    if (!this.supports(input.contentType, input.filename)) {
      throw new HttpError(415, 'UNSUPPORTED_FILE_TYPE', 'Only UTF-8 text, Markdown, log, and CSV files are supported.');
    }
    const chunks: Buffer[] = [];
    let byteLength = 0;
    for await (const chunk of input.stream as AsyncIterable<Uint8Array | string>) {
      const buffer = typeof chunk === 'string' ? Buffer.from(chunk) : Buffer.from(chunk);
      byteLength += buffer.length;
      if (byteLength > input.maxBytes) throw new HttpError(413, 'FILE_TOO_LARGE', 'The text file exceeds the supported size limit.');
      chunks.push(buffer);
    }
    const bytes = Buffer.concat(chunks, byteLength);
    let text: string;
    try {
      text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    } catch {
      throw new HttpError(400, 'INVALID_FILE_ENCODING', 'Text files must contain valid UTF-8.');
    }
    if (text.includes('\0') || /[\u0001-\u0008\u000B\u000C\u000E-\u001F\u007F]/u.test(text)) {
      throw new HttpError(400, 'INVALID_FILE_CONTENT', 'The text file contains unsupported control characters.');
    }
    if (!text.trim()) throw new HttpError(400, 'EMPTY_FILE_CONTENT', 'The text file must contain readable content.');

    const kind = input.contentType === 'text/csv' ? 'CSV' : 'TXT';
    return { kind, text, metadata: { extractorVersion: 'utf8-text-v1', parsedPages: 1 } };
  }
}
