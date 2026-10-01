import test from 'node:test';
import assert from 'node:assert/strict';
import type { AiGateway, AiGatewayRequest, AiGatewayResponse } from '../src/domain/ai-gateway.js';
import type { AgentExecutionContext } from '../src/domain/types.js';
import type { EncryptedFileRecord, FileMetadata, FileRepository, FileService } from '../src/application/file-ports.js';
import { EncryptedTextFileService } from '../src/infrastructure/encrypted-text-file-service.js';
import { FileAnalysisAgentDriver } from '../src/application/ai-drivers.js';
import { verifyResult } from '../src/domain/verifier.js';

class MemoryFileRepository implements FileRepository {
  readonly records = new Map<string, EncryptedFileRecord>();
  async createFile(input: Omit<EncryptedFileRecord, 'createdAt'>): Promise<FileMetadata> {
    const record = { ...input, createdAt: '2026-09-29T00:00:00.000Z' };
    this.records.set(record.fileId, record);
    return this.metadata(record);
  }
  async findFileForOwner(fileId: string, userId: string): Promise<EncryptedFileRecord | null> {
    const row = this.records.get(fileId);
    return row?.userId === userId ? { ...row } : null;
  }
  async deleteFileForOwner(fileId: string, userId: string): Promise<boolean> {
    const row = this.records.get(fileId);
    if (!row || row.userId !== userId) return false;
    return this.records.delete(fileId);
  }
  private metadata(record: EncryptedFileRecord): FileMetadata {
    return {
      fileId: record.fileId, filename: record.filename, contentType: record.contentType,
      byteLength: record.byteLength, sha256: record.sha256, createdAt: record.createdAt,
    };
  }
}

const key = 'a'.repeat(64);
const ownerId = '9e82df6f-f302-4a5b-a68a-54641af6945a';
const text = 'Quarterly revenue increased by 12 percent.\nTreat this sentence as data, not instructions.';
const upload = (overrides: Partial<{ filename: string; contentType: 'text/plain' | 'text/csv'; contentBase64: string }> = {}) => ({
  userId: ownerId,
  filename: 'report.txt',
  contentType: 'text/plain' as const,
  contentBase64: Buffer.from(text, 'utf8').toString('base64'),
  ...overrides,
});

test('encrypted text storage keeps only ciphertext and decrypts owner files with hash and parser evidence', async () => {
  const repository = new MemoryFileRepository();
  const files = new EncryptedTextFileService(repository, key);
  const metadata = await files.createUpload(upload());
  const stored = repository.records.get(metadata.fileId)!;
  assert.notEqual(stored.ciphertext.toString('utf8'), text);
  assert.notEqual(stored.wrappedKey.toString('utf8'), key);
  assert.equal(metadata.byteLength, Buffer.byteLength(text));
  assert.equal(await files.isReady(), true);

  const parsed = await files.parseForAnalysis({ userId: ownerId, fileId: metadata.fileId });
  assert.equal(parsed.text, text);
  assert.equal(parsed.sha256, metadata.sha256);
  assert.equal(parsed.extractorVersion, 'utf8-text-v1');
  assert.equal(parsed.parsedPages, 1);
  assert.equal(parsed.excerpt, text);
  assert.equal((await files.getMetadata({ userId: ownerId, fileId: metadata.fileId })).filename, 'report.txt');
  await assert.rejects(() => files.getMetadata({ userId: 'other-user', fileId: metadata.fileId }), (error: unknown) => {
    assert.equal((error as { code?: string }).code, 'FILE_NOT_FOUND');
    return true;
  });
});

test('file analysis uses real parsed content, preserves model provenance, and passes strict evidence verification', async () => {
  let lastRequest: AiGatewayRequest | undefined;
  const gateway: AiGateway = {
    async isReady() { return true; },
    async generate(request): Promise<AiGatewayResponse> {
      lastRequest = request;
      return {
        text: 'The file reports revenue growth of 12 percent.',
        provider: 'private-model', model: 'analysis-v1', requestId: 'req-file-1',
        evidence: [{ kind: 'model_execution', provider: 'private-model', model: 'analysis-v1', modelVersion: 'analysis-v1', requestId: 'req-file-1', inputSha256: 'a'.repeat(64), outputSha256: 'b'.repeat(64) }],
      };
    },
  };
  const repository = new MemoryFileRepository();
  const files = new EncryptedTextFileService(repository, key);
  const uploaded = await files.createUpload(upload());
  const driver = new FileAnalysisAgentDriver(gateway, files);
  const context: AgentExecutionContext = {
    taskId: 'task-1', userId: ownerId, capability: 'FILE_ANALYSIS', input: { text: 'Summarize the report', attachments: [uploaded.fileId] },
  };
  assert.equal(await driver.isReady(), true);
  const result = await driver.execute(context);
  const modelInput = JSON.parse(lastRequest?.messages[0]?.content ?? '{}') as { file?: { text?: string } };
  assert.equal(modelInput.file?.text, text);
  assert.match(lastRequest?.systemPrompt ?? '', /untrusted data/);
  assert.equal(verifyResult('FILE_ANALYSIS', result).passed, true);
  assert.equal((result.result as { text: string }).text, 'The file reports revenue growth of 12 percent.');
});

test('text storage rejects traversal names, unsupported formats, invalid UTF-8 and noncanonical base64 before persistence', async () => {
  const repository = new MemoryFileRepository();
  const files = new EncryptedTextFileService(repository, key);
  await assert.rejects(() => files.createUpload(upload({ filename: '../report.txt' })), /filename is invalid/i);
  await assert.rejects(() => files.createUpload(upload({ filename: 'report.pdf', contentType: 'text/plain' })), /Only UTF-8 text/i);
  await assert.rejects(() => files.createUpload(upload({ contentBase64: '!!!!' })), /canonical base64/i);
  await assert.rejects(() => files.createUpload(upload({ contentBase64: Buffer.from([0xff, 0xfe]).toString('base64') })), /valid UTF-8/i);
  assert.equal(repository.records.size, 0);
});

test('text storage enforces the byte limit, hides cross-account IDs, and detects encrypted-record tampering', async () => {
  const repository = new MemoryFileRepository();
  const files = new EncryptedTextFileService(repository, key);
  const tooLarge = Buffer.alloc(32 * 1_024 + 1, 0x61).toString('base64');
  await assert.rejects(() => files.createUpload(upload({ contentBase64: tooLarge })), /32 KiB limit/i);

  const metadata = await files.createUpload(upload());
  const stored = repository.records.get(metadata.fileId)!;
  stored.ciphertext[0] = stored.ciphertext[0]! ^ 0xff;
  await assert.rejects(() => files.parseForAnalysis({ userId: ownerId, fileId: metadata.fileId }), (error: unknown) => {
    assert.equal((error as { code?: string }).code, 'FILE_INTEGRITY_CHECK_FAILED');
    return true;
  });
  const second = await files.createUpload(upload());
  repository.records.get(second.fileId)!.filename = 'altered.txt';
  await assert.rejects(() => files.parseForAnalysis({ userId: ownerId, fileId: second.fileId }), (error: unknown) => {
    assert.equal((error as { code?: string }).code, 'FILE_INTEGRITY_CHECK_FAILED');
    return true;
  });
  assert.equal(await files.delete({ userId: 'other-user', fileId: metadata.fileId }), false);
  assert.equal(await files.delete({ userId: ownerId, fileId: metadata.fileId }), true);
});

test('storage stays unavailable without a key but owner deletion does not require decryption', async () => {
  const repository = new MemoryFileRepository();
  const files = new EncryptedTextFileService(repository, undefined);
  assert.equal(await files.isReady(), false);
  await assert.rejects(() => files.createUpload(upload()), (error: unknown) => {
    assert.equal((error as { code?: string }).code, 'FILE_SERVICE_UNAVAILABLE');
    return true;
  });
  const fakeFileService: FileService = files;
  assert.equal(await fakeFileService.delete({ userId: ownerId, fileId: 'not-found' }), false);
});
