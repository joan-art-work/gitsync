import { describe, it, expect, vi } from 'vitest';
import type { App } from 'obsidian';
import type { GitSyncSettings } from '../src/types';

// ── Obsidian mock ──────────────────────────────────────────────────────────
//
// We cannot import the real Obsidian module (it's a bundled desktop app).
// This mock provides the subset of the vault API that SyncService uses.

class MockTFile {
	path: string;
	name: string;
	extension: string;
	stat: { mtime: number; ctime: number; size: number };

	constructor(path: string, mtime = 1000) {
		this.path = path;
		const parts = path.split('/');
		this.name = parts[parts.length - 1] ?? path;
		this.extension = this.name.includes('.') ? (this.name.split('.').pop() ?? '') : '';
		this.stat = { mtime, ctime: mtime, size: 0 };
	}
}

function makeVault(files: MockTFile[] = []) {
	const fileMap = new Map<string, MockTFile>(files.map(f => [f.path, f]));
	const createdFolders = new Set<string>();

	return {
		configDir: '.obsidian',
		getFiles: vi.fn(() => [...fileMap.values()]),
		getAbstractFileByPath: vi.fn((path: string) => fileMap.get(path) ?? null),
		read: vi.fn(async (file: MockTFile) => `content of ${file.path}`),
		readBinary: vi.fn(async () => new ArrayBuffer(4)),
		modify: vi.fn(async (_file: MockTFile, _content: string) => {}),
		modifyBinary: vi.fn(async () => {}),
		create: vi.fn(async (path: string, _content: string) => {
			const f = new MockTFile(path);
			fileMap.set(path, f);
			return f;
		}),
		createBinary: vi.fn(async (path: string) => {
			const f = new MockTFile(path);
			fileMap.set(path, f);
			return f;
		}),
		createFolder: vi.fn(async (path: string) => {
			if (createdFolders.has(path)) throw new Error('Folder already exists.');
			createdFolders.add(path);
		}),
		rename: vi.fn(async (file: MockTFile, newPath: string) => {
			fileMap.delete(file.path);
			file.path = newPath;
			fileMap.set(newPath, file);
		}),
		adapter: {
			exists: vi.fn().mockResolvedValue(true),
			write: vi.fn().mockResolvedValue(undefined),
			mkdir: vi.fn().mockResolvedValue(undefined),
		},
		_fileMap: fileMap,
		_createdFolders: createdFolders
	};
}

type MockVault = ReturnType<typeof makeVault>;

function makeApp(files: MockTFile[] = []) {
	return { vault: makeVault(files) } as unknown as App;
}

function makeSettings(overrides: Partial<GitSyncSettings> = {}): GitSyncSettings {
	return {
		githubUsername: 'user',
		githubToken: 'token',
		repositoryName: 'repo',
		branch: 'main',
		autoSync: false,
		autoSyncInterval: 30,
		lastSyncTime: 0,
		lastSyncedCommitSha: '',
		excludedFolders: ['{{configDir}}/plugins', '.trash'],
		excludedFiles: ['.DS_Store'],
		commitMessage: 'sync: {{date}}',
		conflictStrategy: 'newer-wins',
		syncedFiles: {},
		...overrides
	};
}

vi.mock('obsidian', () => ({
	normalizePath: (p: string) => p.replace(/\\/g, '/'),
	Notice: vi.fn(),
	TFile: MockTFile
}));

// ── import after mock ──────────────────────────────────────────────────────

const { SyncService } = await import('../src/sync-service');

// ── helpers ────────────────────────────────────────────────────────────────

function makeService(files: MockTFile[] = [], settingsOverrides: Partial<GitSyncSettings> = {}) {
	const app = makeApp(files);
	const settings = makeSettings(settingsOverrides);
	const service = new SyncService(app, settings);
	return { service, app, settings };
}

// ── ensureFolder (private — tested via writeFileContent side-effects) ──────

describe('SyncService - ensureFolder (via pull)', () => {
	it('creates nested folders segment by segment', async () => {
		const { service, app } = makeService();
		const api = {
			verifyAccess: vi.fn().mockResolvedValue(true),
			ensureRepository: vi.fn().mockResolvedValue(true),
			getAllFiles: vi.fn().mockResolvedValue([
				{ path: 'a/b/c/deep.md', sha: 'sha1', type: 'file' }
			]),
			getFileContent: vi.fn().mockResolvedValue('hello'),
			getLatestCommitSha: vi.fn().mockResolvedValue('commitsha'),
			getTreeSha: vi.fn().mockResolvedValue('treesha'),
			getRenamedFiles: vi.fn().mockResolvedValue([]),
		};
		// Inject mock API
		 
		(service as any).api = api;
		 
		(service as any).settings = makeSettings();

		await service.pull();

		const createFolder = app.vault.createFolder as ReturnType<typeof vi.fn>;
		const calls: string[] = createFolder.mock.calls.map((c: unknown[]) => c[0] as string);
		// Should have created each segment: 'a', 'a/b', 'a/b/c'
		expect(calls).toContain('a');
		expect(calls).toContain('a/b');
		expect(calls).toContain('a/b/c');
	});

	it('does not throw when folders already exist', async () => {
		// vault.createFolder throws "Folder already exists." for pre-existing folders
		const { service, app } = makeService();
		const vault = app.vault as unknown as MockVault;
		vault.createFolder.mockImplementation(async () => {
			throw new Error('Folder already exists.');
		});

		const api = {
			getLatestCommitSha: vi.fn().mockResolvedValue('commitsha'),
			getAllFiles: vi.fn().mockResolvedValue([
				{ path: 'existing/file.md', sha: 'sha1', type: 'file' }
			]),
			getFileContent: vi.fn().mockResolvedValue('content'),
			getRenamedFiles: vi.fn().mockResolvedValue([]),
		};

		(service as any).api = api;


		(service as any).settings = makeSettings();

		const result = await service.pull();
		// Should NOT propagate the folder-already-exists error
		expect(result.success).toBe(true);
	});
});

// ── writeFileContent: stale vault cache (iOS "file already exists" bug) ────

describe('SyncService - vault cache race condition', () => {
	it('falls back to modify when vault.create throws and file is now found', async () => {
		const file = new MockTFile('note.md', 1000);
		const app = makeApp([]);
		const vault = app.vault as unknown as MockVault;

		// 'note.md' has no folder component → ensureFolder makes no getAbstractFileByPath calls.
		// writeFileContent makes: 1st call (existing check → null), 2nd call (retry → file).
		vault.getAbstractFileByPath
			.mockReturnValueOnce(null)  // existing check in writeFileContent → not found
			.mockReturnValueOnce(file); // retry after create throws → now found

		vault.create.mockRejectedValueOnce(new Error('File already exists.'));

		const service = new SyncService(app, makeSettings());
		 
		await (service as any).writeFileContent('note.md', 'new content');

		expect(vault.modify).toHaveBeenCalledWith(file, 'new content');
	});

	it('re-throws when file genuinely cannot be written', async () => {
		const app = makeApp([]);
		const vault = app.vault as unknown as MockVault;

		vault.getAbstractFileByPath.mockReturnValue(null);
		vault.create.mockRejectedValue(new Error('Disk full'));

		const service = new SyncService(app, makeSettings());
		await expect(
			 
			(service as any).writeFileContent('note.md', 'content')
		).rejects.toThrow('Cannot write file');
	});
});

// ── isExcluded ─────────────────────────────────────────────────────────────

describe('SyncService - file exclusion', () => {
	it('excludes files inside excluded folders', () => {
		const { service } = makeService([], {
			excludedFolders: ['.obsidian/plugins'],
			excludedFiles: []
		});
		 
		expect((service as any).isExcluded('.obsidian/plugins/my-plugin/main.js', 'main.js')).toBe(true);
	});

	it('resolves {{configDir}} placeholder', () => {
		const { service } = makeService([], {
			excludedFolders: ['{{configDir}}/plugins'],
			excludedFiles: []
		});
		// configDir is .obsidian in the mock
		 
		expect((service as any).isExcluded('.obsidian/plugins/foo/main.js', 'main.js')).toBe(true);
	});

	it('excludes specific filenames', () => {
		const { service } = makeService([], {
			excludedFolders: [],
			excludedFiles: ['.DS_Store']
		});
		 
		expect((service as any).isExcluded('notes/.DS_Store', '.DS_Store')).toBe(true);
	});

	it('does not exclude unrelated files', () => {
		const { service } = makeService([], {
			excludedFolders: ['.obsidian/plugins'],
			excludedFiles: ['.DS_Store']
		});
		 
		expect((service as any).isExcluded('notes/readme.md', 'readme.md')).toBe(false);
	});
});

// ── getFileContent (binary detection) ─────────────────────────────────────

describe('SyncService - binary file detection', () => {
	it('wraps binary files with [BINARY:...] marker', async () => {
		const file = new MockTFile('photo.png');
		const app = makeApp([file]);
		app.vault.readBinary = vi.fn().mockResolvedValue(new Uint8Array([1, 2, 3]).buffer);
		const service = new SyncService(app, makeSettings());
		 
		const result = await (service as any).getFileContent(file);
		expect(result).toMatch(/^\[BINARY:/);
		expect(result).toMatch(/\]$/);
	});

	it('reads text files normally', async () => {
		const file = new MockTFile('notes.md');
		const app = makeApp([file]);
		app.vault.read = vi.fn().mockResolvedValue('# Hello');
		const service = new SyncService(app, makeSettings());
		 
		const result = await (service as any).getFileContent(file);
		expect(result).toBe('# Hello');
	});
});

// ── conflict resolution ────────────────────────────────────────────────────

describe('SyncService - resolveConflict', () => {
	async function resolve(
		strategy: string,
		localMtime: number,
		lastSyncMtime: number | undefined,
		lastSyncSha: string | undefined,
		remoteSha: string
	) {
		const localFile = new MockTFile('note.md', localMtime);
		const service = new SyncService(
			makeApp([localFile]),
			makeSettings({
				conflictStrategy: strategy as any,
				syncedFiles: lastSyncSha && lastSyncMtime !== undefined
					? { 'note.md': { sha: lastSyncSha, mtime: lastSyncMtime } }
					: {}
			})
		);
		 
		return (service as any).resolveConflict(strategy, localFile, 'remote content', remoteSha) as Promise<{ writeRemote: boolean; conflictCreated: boolean }>;
	}

	it('local-wins always keeps local', async () => {
		const r = await resolve('local-wins', 2000, 1000, 'oldsha', 'newsha');
		expect(r.writeRemote).toBe(false);
	});

	it('remote-wins always takes remote', async () => {
		const r = await resolve('remote-wins', 2000, 1000, 'oldsha', 'newsha');
		expect(r.writeRemote).toBe(true);
	});

	it('only remote changed → take remote regardless of strategy', async () => {
		// local mtime == last sync mtime → local unchanged
		// remote sha != last sync sha → remote changed
		const r = await resolve('local-wins', 1000, 1000, 'oldsha', 'newsha');
		expect(r.writeRemote).toBe(true);
	});

	it('only local changed → keep local regardless of strategy', async () => {
		// local mtime > last sync mtime → local changed
		// remote sha == last sync sha → remote unchanged
		const r = await resolve('remote-wins', 2000, 1000, 'samasha', 'samasha');
		expect(r.writeRemote).toBe(false);
	});

	it('neither changed → no write', async () => {
		const r = await resolve('newer-wins', 1000, 1000, 'samasha', 'samasha');
		expect(r.writeRemote).toBe(false);
		expect(r.conflictCreated).toBe(false);
	});

	it('newer-wins: keeps local when local is newer', async () => {
		// local mtime (2000) > lastKnown mtime (1000) → remote timestamp baseline = 1000
		// local mtime (2000) > remote timestamp (1000) → local is newer → keep local
		const r = await resolve('newer-wins', 2000, 1000, 'oldsha', 'newsha');
		expect(r.writeRemote).toBe(false);
	});

	it('newer-wins: takes remote when local is older', async () => {
		// local mtime (500) <= lastKnown mtime (1000) → remote is newer → take remote
		const r = await resolve('newer-wins', 500, 1000, 'oldsha', 'newsha');
		expect(r.writeRemote).toBe(true);
	});

	it('duplicate: creates conflict copy, keeps local', async () => {
		const localFile = new MockTFile('note.md', 2000);
		const app = makeApp([localFile]);
		// Stub writeFileContent on the service instance
		const service = new SyncService(app, makeSettings({
			conflictStrategy: 'duplicate',
			syncedFiles: { 'note.md': { sha: 'oldsha', mtime: 1000 } }
		}));
		 
		const writeSpy = vi.spyOn(service as any, 'writeFileContent').mockResolvedValue(undefined);

		 
		const result = await (service as any).resolveConflict('duplicate', localFile, 'remote content', 'newsha');
		expect(result.writeRemote).toBe(false);
		expect(result.conflictCreated).toBe(true);
		expect(writeSpy).toHaveBeenCalledOnce();
		const [conflictPath] = writeSpy.mock.calls[0] as [string, string];
		expect(conflictPath).toMatch(/\.conflict-/);
		expect(conflictPath).toMatch(/\.md$/);
	});
});

// ── push single file ───────────────────────────────────────────────────────

describe('SyncService.pushFile', () => {
	it('pushes the file and updates syncedFiles', async () => {
		const file = new MockTFile('notes/hello.md', 1000);
		const { service, settings } = makeService([file]);

		const api = {
			putFile: vi.fn().mockResolvedValue(true),
			getFileSha: vi.fn().mockResolvedValue('new-sha')
		};
		 
		(service as any).api = api;

		const result = await service.pushFile(file as unknown as import('obsidian').TFile);
		expect(result.success).toBe(true);
		expect(result.filesUploaded).toBe(1);
		expect(settings.syncedFiles['notes/hello.md']?.sha).toBe('new-sha');
	});

	it('returns failure when file is excluded', async () => {
		const file = new MockTFile('.obsidian/plugins/foo.md');
		const { service } = makeService([file], {
			excludedFolders: ['.obsidian/plugins']
		});
		 
		(service as any).api = { putFile: vi.fn() };

		const result = await service.pushFile(file as unknown as import('obsidian').TFile);
		expect(result.success).toBe(false);
		expect(result.message).toMatch(/excluded/);
	});

	it('returns failure when not configured', async () => {
		const file = new MockTFile('note.md');
		const { service } = makeService([file], {
			githubUsername: '',
			githubToken: '',
			repositoryName: ''
		});
		const result = await service.pushFile(file as unknown as import('obsidian').TFile);
		expect(result.success).toBe(false);
	});
});

// ── normalizeLineEndings ──────────────────────────────────────────────────────

describe('SyncService - normalizeLineEndings', () => {
	it('converts CRLF to LF', () => {
		const { service } = makeService();
		expect((service as any).normalizeLineEndings('a\r\nb\r\nc')).toBe('a\nb\nc');
	});

	it('leaves LF-only content unchanged', () => {
		const { service } = makeService();
		expect((service as any).normalizeLineEndings('a\nb\nc')).toBe('a\nb\nc');
	});

	it('handles mixed line endings', () => {
		const { service } = makeService();
		expect((service as any).normalizeLineEndings('a\r\nb\nc\r\n')).toBe('a\nb\nc\n');
	});
});

// ── computeGitBlobSha ─────────────────────────────────────────────────────────

describe('SyncService - computeGitBlobSha', () => {
	it('matches the known git SHA for "hello\\n"', async () => {
		const { service } = makeService();
		// Verified: git hash-object /tmp/hello.txt (file containing "hello\n")
		const sha = await (service as any).computeGitBlobSha('hello\n');
		expect(sha).toBe('ce013625030ba8dba906f756967f9e9ca394464a');
	});

	it('produces different SHAs for CRLF vs LF content', async () => {
		const { service } = makeService();
		const shaLF   = await (service as any).computeGitBlobSha('line1\nline2\n');
		const shaCRLF = await (service as any).computeGitBlobSha('line1\r\nline2\r\n');
		expect(shaLF).not.toBe(shaCRLF);
	});
});

// ── hasContentChanged ─────────────────────────────────────────────────────────

describe('SyncService - hasContentChanged', () => {
	it('returns true for a file with no sync state (never synced)', async () => {
		const file = new MockTFile('note.md', 2000);
		const { service } = makeService([file], { syncedFiles: {} });
		expect(await (service as any).hasContentChanged(file, 'content')).toBe(true);
	});

	it('returns false when mtime has not changed since last sync', async () => {
		const file = new MockTFile('note.md', 1000);
		const { service } = makeService([file], {
			syncedFiles: { 'note.md': { sha: 'old-sha', mtime: 1000 } }
		});
		expect(await (service as any).hasContentChanged(file, 'content')).toBe(false);
	});

	it('returns false when only CRLF line endings differ (content SHA matches)', async () => {
		const file = new MockTFile('note.md', 2000);
		const { service } = makeService([file]);
		// Pre-compute SHA of the LF-normalized content
		const lfContent = 'line1\nline2\n';
		const sha: string = await (service as any).computeGitBlobSha(lfContent);
		(service as any).settings.syncedFiles = { 'note.md': { sha, mtime: 1000 } };
		// Pass in already-normalized content — SHA should match
		expect(await (service as any).hasContentChanged(file, lfContent)).toBe(false);
	});

	it('returns true when content genuinely changed', async () => {
		const file = new MockTFile('note.md', 2000);
		const { service } = makeService([file], {
			syncedFiles: { 'note.md': { sha: 'old-sha', mtime: 1000 } }
		});
		expect(await (service as any).hasContentChanged(file, 'new content')).toBe(true);
	});

	it('returns true for binary files when mtime changed (skips SHA check)', async () => {
		const file = new MockTFile('photo.png', 2000);
		const { service } = makeService([file], {
			syncedFiles: { 'photo.png': { sha: 'any-sha', mtime: 1000 } }
		});
		// Binary: mtime changed → always push, no SHA computation
		expect(await (service as any).hasContentChanged(file, '[BINARY:abc]')).toBe(true);
	});
});

// ── push: smart diff ──────────────────────────────────────────────────────────

describe('SyncService.push - smart diff', () => {
	function makeApiStub(overrides: Record<string, unknown> = {}) {
		return {
			ensureRepository: vi.fn().mockResolvedValue(true),
			batchUpload: vi.fn().mockResolvedValue(true),
			getAllFiles: vi.fn().mockResolvedValue([]),
			...overrides
		};
	}

	it('skips unchanged files (mtime not changed)', async () => {
		const file = new MockTFile('note.md', 1000);
		const { service, settings } = makeService([file], {
			syncedFiles: { 'note.md': { sha: 'sha1', mtime: 1000 } }
		});
		const api = makeApiStub();
		(service as any).api = api;

		await service.push();

		expect(api.batchUpload).not.toHaveBeenCalled();
	});

	it('skips files where only CRLF differs', async () => {
		const file = new MockTFile('note.md', 2000);
		const lfContent = 'line1\nline2\n';
		const app = makeApp([file]);
		(app.vault as unknown as MockVault).read = vi.fn().mockResolvedValue('line1\r\nline2\r\n');

		const { service, settings } = makeService([], {
			syncedFiles: {}
		});
		(service as any).app = app;

		// Compute what the SHA of the LF content would be
		const sha: string = await (service as any).computeGitBlobSha(lfContent);
		(service as any).settings = { ...(service as any).settings, syncedFiles: { 'note.md': { sha, mtime: 1000 } } };

		const api = makeApiStub();
		(service as any).api = api;

		await service.push();

		expect(api.batchUpload).not.toHaveBeenCalled();
	});

	it('pushes only the files that genuinely changed', async () => {
		const unchanged = new MockTFile('unchanged.md', 1000);
		const changed = new MockTFile('changed.md', 2000);
		const app = makeApp([unchanged, changed]);
		const vault = app.vault as unknown as MockVault;
		vault.read = vi.fn().mockImplementation(async (f: MockTFile) =>
			f.path === 'changed.md' ? 'new content' : 'same content'
		);

		const { service } = makeService([], {
			syncedFiles: {
				'unchanged.md': { sha: 'old', mtime: 1000 },
				'changed.md': { sha: 'old', mtime: 1000 }
			}
		});
		(service as any).app = app;

		const api = makeApiStub({
			getAllFiles: vi.fn().mockResolvedValue([
				{ path: 'unchanged.md', sha: 'old' },
				{ path: 'changed.md', sha: 'new' }
			])
		});
		(service as any).api = api;

		await service.push();

		expect(api.batchUpload).toHaveBeenCalledOnce();
		const [files] = (api.batchUpload as ReturnType<typeof vi.fn>).mock.calls[0] as [Array<{path: string}>];
		expect(files).toHaveLength(1);
		expect(files[0]!.path).toBe('changed.md');
	});
});

// ── contentSimilarity ─────────────────────────────────────────────────────────

describe('SyncService - contentSimilarity', () => {
	it('returns 1 for identical content', () => {
		const { service } = makeService();
		expect((service as any).contentSimilarity('a\nb\nc', 'a\nb\nc')).toBe(1);
	});

	it('returns 0 for completely different content', () => {
		const { service } = makeService();
		expect((service as any).contentSimilarity('foo\nbar', 'baz\nqux')).toBe(0);
	});

	it('computes partial overlap correctly (Jaccard 2/4)', () => {
		const { service } = makeService();
		// a,b,c vs b,c,d → intersection={b,c}, union={a,b,c,d} → 2/4 = 0.5
		const score = (service as any).contentSimilarity('a\nb\nc', 'b\nc\nd');
		expect(score).toBeCloseTo(0.5);
	});

	it('returns 1 when both strings are empty', () => {
		const { service } = makeService();
		expect((service as any).contentSimilarity('', '')).toBe(1);
	});

	it('returns 0 when one side is empty', () => {
		const { service } = makeService();
		expect((service as any).contentSimilarity('a\nb', '')).toBe(0);
	});

	it('ignores leading/trailing whitespace on lines', () => {
		const { service } = makeService();
		// '  hello  ' and 'hello' should be treated as the same line after trim
		expect((service as any).contentSimilarity('  hello  \n  world  ', 'hello\nworld')).toBe(1);
	});
});

// ── detectMoves ───────────────────────────────────────────────────────────────

describe('SyncService - detectMoves', () => {
	type TFileAlias = import('obsidian').TFile;

	it('Phase 0: detects rename via GitHub Compare API', async () => {
		const oldFile = new MockTFile('old/note.md', 1000);
		const { service } = makeService([oldFile], {
			syncedFiles: { 'old/note.md': { sha: 'sha1', mtime: 1000 } },
			lastSyncedCommitSha: 'base-sha'
		});

		const remoteFiles = [{ path: 'new/note.md', sha: 'sha1', type: 'file' as const }];
		const localFileMap = new Map<string, TFileAlias>([['old/note.md', oldFile as unknown as TFileAlias]]);

		const api = {
			getRenamedFiles: vi.fn().mockResolvedValue([{ oldPath: 'old/note.md', newPath: 'new/note.md' }]),
			getFileContent: vi.fn().mockResolvedValue(null)
		};
		(service as any).api = api;

		const moves = await service.detectMoves('head-sha', remoteFiles as any, localFileMap);
		expect(moves).toHaveLength(1);
		expect(moves[0]!.oldPath).toBe('old/note.md');
		expect(moves[0]!.newPath).toBe('new/note.md');
		// SHA unchanged → contentChanged = false
		expect(moves[0]!.contentChanged).toBe(false);
	});

	it('Phase 0: marks contentChanged when SHA differs after rename', async () => {
		const oldFile = new MockTFile('old/note.md', 1000);
		const { service } = makeService([oldFile], {
			syncedFiles: { 'old/note.md': { sha: 'old-sha', mtime: 1000 } },
			lastSyncedCommitSha: 'base-sha'
		});

		const remoteFiles = [{ path: 'new/note.md', sha: 'new-sha', type: 'file' as const }];
		const localFileMap = new Map<string, TFileAlias>([['old/note.md', oldFile as unknown as TFileAlias]]);

		const api = {
			getRenamedFiles: vi.fn().mockResolvedValue([{ oldPath: 'old/note.md', newPath: 'new/note.md' }]),
			getFileContent: vi.fn().mockResolvedValue(null)
		};
		(service as any).api = api;

		const moves = await service.detectMoves('head-sha', remoteFiles as any, localFileMap);
		expect(moves[0]!.contentChanged).toBe(true);
	});

	it('Phase 1: detects rename via exact SHA match (no Compare API)', async () => {
		const oldFile = new MockTFile('folder-a/note.md', 1000);
		const { service } = makeService([oldFile], {
			syncedFiles: { 'folder-a/note.md': { sha: 'exact-sha', mtime: 1000 } },
			lastSyncedCommitSha: '' // disables Compare API
		});

		const remoteFiles = [{ path: 'folder-b/note.md', sha: 'exact-sha', type: 'file' as const }];
		const localFileMap = new Map<string, TFileAlias>([['folder-a/note.md', oldFile as unknown as TFileAlias]]);

		const api = { getRenamedFiles: vi.fn().mockResolvedValue([]), getFileContent: vi.fn() };
		(service as any).api = api;

		const moves = await service.detectMoves('head-sha', remoteFiles as any, localFileMap);
		expect(moves).toHaveLength(1);
		expect(moves[0]!.oldPath).toBe('folder-a/note.md');
		expect(moves[0]!.newPath).toBe('folder-b/note.md');
		expect(moves[0]!.contentChanged).toBe(false);
	});

	it('Phase 2: detects rename via content similarity', async () => {
		const oldFile = new MockTFile('src/doc.md', 1000);
		const app = makeApp([oldFile]);
		(app.vault as unknown as MockVault).read = vi.fn().mockResolvedValue('line1\nline2\nline3');

		const { service } = makeService([], {
			syncedFiles: { 'src/doc.md': { sha: 'old-sha', mtime: 1000 } },
			lastSyncedCommitSha: ''
		});
		(service as any).app = app;

		const remoteFiles = [{ path: 'dst/doc.md', sha: 'new-sha', type: 'file' as const }];
		const localFileMap = new Map<string, TFileAlias>([['src/doc.md', oldFile as unknown as TFileAlias]]);

		// Remote content is very similar (>0.5 Jaccard) to local
		const api = {
			getRenamedFiles: vi.fn().mockResolvedValue([]),
			getFileContent: vi.fn().mockResolvedValue('line1\nline2\nline3\nline4')
		};
		(service as any).api = api;

		const moves = await service.detectMoves('head-sha', remoteFiles as any, localFileMap);
		expect(moves).toHaveLength(1);
		expect(moves[0]!.oldPath).toBe('src/doc.md');
		expect(moves[0]!.newPath).toBe('dst/doc.md');
		expect(moves[0]!.contentChanged).toBe(true);
	});

	it('Phase 2: skips binary files', async () => {
		const oldFile = new MockTFile('img/photo.png', 1000);
		const { service } = makeService([oldFile], {
			syncedFiles: { 'img/photo.png': { sha: 'old-sha', mtime: 1000 } },
			lastSyncedCommitSha: ''
		});

		const remoteFiles = [{ path: 'pics/photo.png', sha: 'new-sha', type: 'file' as const }];
		const localFileMap = new Map<string, TFileAlias>([['img/photo.png', oldFile as unknown as TFileAlias]]);

		const api = { getRenamedFiles: vi.fn().mockResolvedValue([]), getFileContent: vi.fn() };
		(service as any).api = api;

		const moves = await service.detectMoves('head-sha', remoteFiles as any, localFileMap);
		// Binary files are excluded from Phase 2; no other phases matched → no moves
		expect(moves).toHaveLength(0);
		expect(api.getFileContent).not.toHaveBeenCalled();
	});

	it('returns empty when no files are missing remotely', async () => {
		const file = new MockTFile('note.md', 1000);
		const { service } = makeService([file], {
			syncedFiles: { 'note.md': { sha: 'sha1', mtime: 1000 } }
		});

		// Remote still has the same file — nothing is missing
		const remoteFiles = [{ path: 'note.md', sha: 'sha1', type: 'file' as const }];
		const localFileMap = new Map<string, TFileAlias>([['note.md', file as unknown as TFileAlias]]);

		const moves = await service.detectMoves('head-sha', remoteFiles as any, localFileMap);
		expect(moves).toHaveLength(0);
	});
});

// ── applyMoves ────────────────────────────────────────────────────────────────

describe('SyncService - applyMoves', () => {
	it('renames file in vault and updates syncedFiles', async () => {
		const oldFile = new MockTFile('old/note.md', 1000);
		const newFile = new MockTFile('new/note.md', 2000);
		const app = makeApp([oldFile]);
		const vault = app.vault as unknown as MockVault;
		vault.rename = vi.fn().mockResolvedValue(undefined);
		vault.getAbstractFileByPath = vi.fn((path: string) => {
			if (path === 'old/note.md') return oldFile;
			if (path === 'new/note.md') return newFile;
			return null;
		});
		// ensureFolder calls createFolder for 'new'
		vault.createFolder = vi.fn().mockResolvedValue(undefined);

		const { service, settings } = makeService([], {
			syncedFiles: { 'old/note.md': { sha: 'sha1', mtime: 1000 } }
		});
		(service as any).app = app;

		const remoteFileMap = new Map([['new/note.md', { path: 'new/note.md', sha: 'sha2', type: 'file' as const }]]);
		const moves = [{ oldPath: 'old/note.md', newPath: 'new/note.md', contentChanged: false }];

		const count = await (service as any).applyMoves(moves, remoteFileMap);

		expect(count).toBe(1);
		expect(vault.rename).toHaveBeenCalledWith(oldFile, 'new/note.md');
		expect(settings.syncedFiles['old/note.md']).toBeUndefined();
		expect(settings.syncedFiles['new/note.md']?.sha).toBe('sha2');
	});

	it('fetches updated content when contentChanged is true', async () => {
		const oldFile = new MockTFile('src/note.md', 1000);
		const movedFile = new MockTFile('dst/note.md', 2000);
		const app = makeApp([oldFile]);
		const vault = app.vault as unknown as MockVault;
		vault.rename = vi.fn().mockResolvedValue(undefined);
		vault.modify = vi.fn().mockResolvedValue(undefined);
		vault.getAbstractFileByPath = vi.fn((path: string) => {
			if (path === 'src/note.md') return oldFile;
			if (path === 'dst/note.md') return movedFile;
			return null;
		});
		vault.createFolder = vi.fn().mockResolvedValue(undefined);

		const { service, settings } = makeService([], {
			syncedFiles: { 'src/note.md': { sha: 'old-sha', mtime: 1000 } }
		});
		(service as any).app = app;

		const api = { getFileContent: vi.fn().mockResolvedValue('updated content') };
		(service as any).api = api;

		const remoteFileMap = new Map([['dst/note.md', { path: 'dst/note.md', sha: 'new-sha', type: 'file' as const }]]);
		const moves = [{ oldPath: 'src/note.md', newPath: 'dst/note.md', contentChanged: true }];

		const count = await (service as any).applyMoves(moves, remoteFileMap);

		expect(count).toBe(1);
		expect(api.getFileContent).toHaveBeenCalledWith('dst/note.md');
		expect(vault.modify).toHaveBeenCalledWith(movedFile, 'updated content');
		expect(settings.syncedFiles['dst/note.md']?.sha).toBe('new-sha');
	});

	it('skips move when local file no longer exists', async () => {
		const app = makeApp([]);
		const vault = app.vault as unknown as MockVault;
		vault.rename = vi.fn();
		vault.getAbstractFileByPath = vi.fn().mockReturnValue(null);

		const { service } = makeService();
		(service as any).app = app;

		const remoteFileMap = new Map([['new/note.md', { path: 'new/note.md', sha: 'sha1', type: 'file' as const }]]);
		const moves = [{ oldPath: 'old/note.md', newPath: 'new/note.md', contentChanged: false }];

		const count = await (service as any).applyMoves(moves, remoteFileMap);

		expect(count).toBe(0);
		expect(vault.rename).not.toHaveBeenCalled();
	});

	it('returns 0 for empty moves array', async () => {
		const { service } = makeService();
		const count = await (service as any).applyMoves([], new Map());
		expect(count).toBe(0);
	});
});
