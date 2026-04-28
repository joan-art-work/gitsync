import { describe, it, expect, vi } from 'vitest';
import type { App } from 'obsidian';
import type { GitSyncSettings } from '../src/types';

// vi.hoisted() runs before vi.mock() factories and before any imports, so
// MockTFile can safely be referenced inside the vi.mock() factory below.
const MockTFile = vi.hoisted(() => {
	return class {
		path: string;
		name: string;
		extension: string;
		stat: { mtime: number; ctime: number; size: number };

		constructor(path: string, mtime = 1000) {
			this.path = path;
			const parts = path.split('/');
			this.name = parts[parts.length - 1] ?? path;
			this.extension = this.name.includes('.')
				? (this.name.split('.').pop() ?? '')
				: '';
			this.stat = { mtime, ctime: mtime, size: 0 };
		}
	};
});

type MockTFileInstance = InstanceType<typeof MockTFile>;

function makeVault(files: MockTFileInstance[] = []) {
	const fileMap = new Map<string, MockTFileInstance>(files.map(f => [f.path, f]));
	const createdFolders = new Set<string>();

	return {
		configDir: '.obsidian',
		getFiles: vi.fn(() => [...fileMap.values()]),
		getAbstractFileByPath: vi.fn((path: string) => fileMap.get(path) ?? null),
		read: vi.fn(async (file: MockTFileInstance) => `content of ${file.path}`),
		readBinary: vi.fn(async () => new ArrayBuffer(4)),
		modify: vi.fn(async (file: MockTFileInstance, content: string) => {
			}),
		modifyBinary: vi.fn(async () => {}),
		create: vi.fn(async (path: string, content: string) => {
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
		adapter: {
			exists: vi.fn().mockResolvedValue(true),
			write: vi.fn().mockResolvedValue(undefined),
			mkdir: vi.fn().mockResolvedValue(undefined),
		},
		_fileMap: fileMap,
		_createdFolders: createdFolders
	};
}

function makeApp(files: MockTFileInstance[] = []) {
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

// Vitest hoists vi.mock() before imports, so a static import is fine here.
import { SyncService } from '../src/sync-service';

type MockVault = ReturnType<typeof makeVault>;

// ── helpers ────────────────────────────────────────────────────────────────

function makeService(files: MockTFileInstance[] = [], settingsOverrides: Partial<GitSyncSettings> = {}) {
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
			getAllFiles: vi.fn().mockResolvedValue([
				{ path: 'existing/file.md', sha: 'sha1', type: 'file' }
			]),
			getFileContent: vi.fn().mockResolvedValue('content'),
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

	it('falls back to adapter.write for config files not in vault index (.obsidian/app.json)', async () => {
		const app = makeApp([]);
		const vault = app.vault as unknown as MockVault;

		// Config file: getAbstractFileByPath always returns null (not in vault index),
		// vault.create throws, but adapter.exists returns true → adapter.write is called.
		vault.getAbstractFileByPath.mockReturnValue(null);
		vault.create.mockRejectedValueOnce(new Error('File already exists.'));
		const adapterWrite = vi.fn().mockResolvedValue(undefined);
		const adapterExists = vi.fn().mockResolvedValue(true);
		(app as any).vault.adapter = { exists: adapterExists, write: adapterWrite, mkdir: vi.fn() };

		const service = new SyncService(app, makeSettings());
		await (service as any).writeFileContent('.obsidian/app.json', '{}');

		expect(adapterWrite).toHaveBeenCalledWith('.obsidian/app.json', '{}');
	});

	it('re-throws when file genuinely cannot be written', async () => {
		const app = makeApp([]);
		const vault = app.vault as unknown as MockVault;

		vault.getAbstractFileByPath.mockReturnValue(null);
		vault.create.mockRejectedValue(new Error('Disk full'));
		(app as any).vault.adapter = {
			exists: vi.fn().mockResolvedValue(false),
			write: vi.fn(),
			mkdir: vi.fn()
		};

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
