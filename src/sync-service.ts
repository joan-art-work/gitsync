import { App, TFile, Notice, normalizePath } from 'obsidian';
import { GitHubAPI } from './github-api';
import { GitSyncSettings, SyncResult, GitHubFile, ConflictStrategy, FileSyncState } from './types';

export class SyncService {
	private app: App;
	private settings: GitSyncSettings;
	private api: GitHubAPI | null = null;
	private isSyncing: boolean = false;

	constructor(app: App, settings: GitSyncSettings) {
		this.app = app;
		this.settings = settings;
		this.initializeAPI();
	}

	updateSettings(settings: GitSyncSettings): void {
		this.settings = settings;
		this.initializeAPI();
	}

	private initializeAPI(): void {
		if (this.settings.githubUsername && this.settings.githubToken && this.settings.repositoryName) {
			this.api = new GitHubAPI(
				this.settings.githubUsername,
				this.settings.githubToken,
				this.settings.repositoryName,
				this.settings.branch
			);
		} else {
			this.api = null;
		}
	}

	isConfigured(): boolean {
		return this.api !== null;
	}

	isBusy(): boolean {
		return this.isSyncing;
	}

	async verifyConnection(): Promise<boolean> {
		if (!this.api) return false;
		return await this.api.verifyAccess();
	}

	private resolveConfigDir(path: string): string {
		return path.replace('{{configDir}}', this.app.vault.configDir);
	}

	private getVaultFiles(): TFile[] {
		const allFiles = this.app.vault.getFiles();
		return allFiles.filter(file => !this.isExcluded(file.path, file.name));
	}

	private isExcluded(filePath: string, fileName: string): boolean {
		for (const folder of this.settings.excludedFolders) {
			const resolved = this.resolveConfigDir(folder);
			if (filePath.startsWith(resolved)) return true;
		}
		for (const excl of this.settings.excludedFiles) {
			if (fileName === excl || filePath.endsWith(excl)) return true;
		}
		return false;
	}

	private isExcludedPath(filePath: string): boolean {
		const fileName = filePath.split('/').pop() ?? filePath;
		return this.isExcluded(filePath, fileName);
	}

	// TODO: Expand binary extension list — missing .zip, .docx, .xlsx, .pptx, .odt, .ttf, .woff, .woff2, .otf, .mov, .avi, .mkv, .wav, .flac, .aac
	private readonly BINARY_EXTENSIONS = new Set([
		'png', 'jpg', 'jpeg', 'gif', 'pdf', 'mp3', 'mp4',
		'webp', 'svg', 'ico', 'bmp', 'tiff', 'tif'
	]);

	private isBinaryFile(file: TFile): boolean {
		return this.BINARY_EXTENSIONS.has(file.extension.toLowerCase());
	}

	private async getFileContent(file: TFile): Promise<string> {
		if (this.isBinaryFile(file)) {
			const arrayBuffer = await this.app.vault.readBinary(file);
			const bytes = new Uint8Array(arrayBuffer);
			let binary = '';
			for (let i = 0; i < bytes.length; i++) {
				binary += String.fromCharCode(bytes[i] as number);
			}
			return `[BINARY:${btoa(binary)}]`;
		}
		return await this.app.vault.read(file);
	}

	private async writeFileContent(path: string, content: string): Promise<void> {
		const normalizedPath = normalizePath(path);
		await this.ensureFolder(normalizedPath);

		if (content.startsWith('[BINARY:') && content.endsWith(']')) {
			const base64 = content.slice(8, -1);
			const binary = atob(base64);
			const bytes = new Uint8Array(binary.length);
			for (let i = 0; i < binary.length; i++) {
				bytes[i] = binary.charCodeAt(i);
			}
			const existing = this.app.vault.getAbstractFileByPath(normalizedPath);
			if (existing instanceof TFile) {
				await this.app.vault.modifyBinary(existing, bytes.buffer);
			} else {
				try {
					await this.app.vault.createBinary(normalizedPath, bytes.buffer);
				} catch {
					// Vault cache may be stale on iOS — file exists on disk but not indexed yet
					const retried = this.app.vault.getAbstractFileByPath(normalizedPath);
					if (retried instanceof TFile) {
						await this.app.vault.modifyBinary(retried, bytes.buffer);
					} else {
						throw new Error(`Cannot write binary file: ${normalizedPath}`);
					}
				}
			}
		} else {
			const existing = this.app.vault.getAbstractFileByPath(normalizedPath);
			if (existing instanceof TFile) {
				await this.app.vault.modify(existing, content);
			} else {
				try {
					await this.app.vault.create(normalizedPath, content);
				} catch {
					// Vault cache may be stale on iOS — file exists on disk but not indexed yet
					const retried = this.app.vault.getAbstractFileByPath(normalizedPath);
					if (retried instanceof TFile) {
						await this.app.vault.modify(retried, content);
					} else {
						throw new Error(`Cannot write file: ${normalizedPath}`);
					}
				}
			}
		}
	}

	/**
	 * Creates all intermediate folders for filePath, segment by segment.
	 * vault.createFolder does NOT create missing parent dirs, so we must walk the tree.
	 */
	private async ensureFolder(filePath: string): Promise<void> {
		const parts = filePath.split('/');
		parts.pop(); // remove filename
		let current = '';
		for (const part of parts) {
			if (!part) continue;
			current = current ? `${current}/${part}` : part;
			if (!this.app.vault.getAbstractFileByPath(current)) {
				try {
					await this.app.vault.createFolder(current);
				} catch {
					// Another concurrent operation may have created it; ignore.
				}
			}
		}
	}

	private getCommitMessage(): string {
		const now = new Date();
		const dateStr = now.toISOString().replace('T', ' ').split('.')[0] ?? '';
		return this.settings.commitMessage.replace('{{date}}', dateStr);
	}

	// ─── Conflict resolution ──────────────────────────────────────────────────

	/**
	 * Determine whether a file has a conflict and resolve it based on strategy.
	 * Returns true if the remote version should be written to disk.
	 */
	private async resolveConflict(
		strategy: ConflictStrategy,
		localFile: TFile,
		remoteContent: string,
		remoteSha: string
	): Promise<{ writeRemote: boolean; conflictCreated: boolean }> {
		const lastKnown = this.settings.syncedFiles[localFile.path];

		// Determine what changed since last sync
		const remoteChangedSinceSync = !lastKnown || lastKnown.sha !== remoteSha;
		const localChangedSinceSync = !lastKnown || localFile.stat.mtime > lastKnown.mtime;

		// No real conflict: only remote changed → take remote
		if (remoteChangedSinceSync && !localChangedSinceSync) {
			return { writeRemote: true, conflictCreated: false };
		}
		// No real conflict: only local changed → keep local
		if (localChangedSinceSync && !remoteChangedSinceSync) {
			return { writeRemote: false, conflictCreated: false };
		}
		// Neither changed (both match last sync state) → no-op
		if (!remoteChangedSinceSync && !localChangedSinceSync) {
			return { writeRemote: false, conflictCreated: false };
		}

		// Both changed → real conflict; apply strategy
		switch (strategy) {
			case 'local-wins':
				return { writeRemote: false, conflictCreated: false };

			case 'remote-wins':
				return { writeRemote: true, conflictCreated: false };

			case 'newer-wins': {
				// TODO: Fetch the remote commit timestamp from the GitHub Commits API for a more
				// accurate comparison. For now, use lastKnown.mtime as the remote baseline.
				const remoteTimestamp = lastKnown?.mtime ?? 0;
				return {
					writeRemote: localFile.stat.mtime <= remoteTimestamp,
					conflictCreated: false
				};
			}

			case 'duplicate': {
				// Keep local, write remote as a conflict copy
				const ext = localFile.extension ? `.${localFile.extension}` : '';
				const base = localFile.path.slice(0, localFile.path.length - ext.length);
				const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
				const conflictPath = `${base}.conflict-${stamp}${ext}`;
				await this.writeFileContent(conflictPath, remoteContent);
				new Notice(`GitSync: Conflict saved as ${conflictPath}`);
				return { writeRemote: false, conflictCreated: true };
			}
		}
	}

	// ─── Push ─────────────────────────────────────────────────────────────────

	async push(): Promise<SyncResult> {
		if (!this.api) {
			return { success: false, message: 'GitHub not configured', filesUploaded: 0, filesDownloaded: 0, filesDeleted: 0, conflicts: 0 };
		}
		if (this.isSyncing) {
			return { success: false, message: 'Sync already in progress', filesUploaded: 0, filesDownloaded: 0, filesDeleted: 0, conflicts: 0 };
		}
		this.isSyncing = true;
		try {
			new Notice('Pushing to GitHub.');
			const repoExists = await this.api.ensureRepository();
			if (!repoExists) throw new Error('Could not access or create repository');

			const vaultFiles = this.getVaultFiles();
			const filesToUpload: Array<{ path: string; content: string }> = [];
			for (const file of vaultFiles) {
				filesToUpload.push({ path: file.path, content: await this.getFileContent(file) });
			}

			if (filesToUpload.length === 0) {
				return { success: true, message: 'No files to push', filesUploaded: 0, filesDownloaded: 0, filesDeleted: 0, conflicts: 0 };
			}

			// TODO: GitHub Git Data API has a tree-size limit (~100 000 entries). For very large
			// vaults this call will fail. Consider chunking into multiple commits.
			const success = await this.api.batchUpload(filesToUpload, this.getCommitMessage());
			if (!success) throw new Error('Failed to push files to GitHub');

			// Record sync state so conflict detection works on next pull
			const remoteFiles = await this.api.getAllFiles();
			const shaMap = new Map(remoteFiles.map(f => [f.path, f.sha]));
			for (const file of vaultFiles) {
				const sha = shaMap.get(file.path);
				if (sha) {
					this.settings.syncedFiles[file.path] = { sha, mtime: file.stat.mtime };
				}
			}

			new Notice(`GitSync: Pushed ${filesToUpload.length} files to GitHub`);
			return { success: true, message: `Pushed ${filesToUpload.length} files`, filesUploaded: filesToUpload.length, filesDownloaded: 0, filesDeleted: 0, conflicts: 0 };
		} catch (error) {
			const message = error instanceof Error ? error.message : 'Unknown error';
			new Notice(`GitSync: Push failed - ${message}`);
			return { success: false, message, filesUploaded: 0, filesDownloaded: 0, filesDeleted: 0, conflicts: 0 };
		} finally {
			this.isSyncing = false;
		}
	}

	// ─── Push single file ─────────────────────────────────────────────────────

	async pushFile(file: TFile): Promise<SyncResult> {
		if (!this.api) {
			return { success: false, message: 'GitHub not configured', filesUploaded: 0, filesDownloaded: 0, filesDeleted: 0, conflicts: 0 };
		}
		// TODO: isBusy check uses a single boolean; it does not distinguish between a full
		// sync in progress and a single-file push, so a pushFile cannot run concurrently
		// with itself. Consider a per-file lock map for finer-grained control.
		if (this.isSyncing) {
			return { success: false, message: 'Sync already in progress', filesUploaded: 0, filesDownloaded: 0, filesDeleted: 0, conflicts: 0 };
		}
		if (this.isExcluded(file.path, file.name)) {
			return { success: false, message: 'File is excluded from sync', filesUploaded: 0, filesDownloaded: 0, filesDeleted: 0, conflicts: 0 };
		}
		this.isSyncing = true;
		try {
			new Notice(`GitSync: Pushing ${file.name}…`);
			const content = await this.getFileContent(file);
			const success = await this.api.putFile(file.path, content, this.getCommitMessage());
			if (!success) throw new Error(`Failed to upload ${file.name}`);

			// Update sync state for this file
			const sha = await this.api.getFileSha(file.path);
			if (sha) {
				this.settings.syncedFiles[file.path] = { sha, mtime: file.stat.mtime };
			}

			new Notice(`GitSync: Pushed ${file.name}`);
			return { success: true, message: `Pushed ${file.name}`, filesUploaded: 1, filesDownloaded: 0, filesDeleted: 0, conflicts: 0 };
		} catch (error) {
			const message = error instanceof Error ? error.message : 'Unknown error';
			new Notice(`GitSync: Push failed - ${message}`);
			return { success: false, message, filesUploaded: 0, filesDownloaded: 0, filesDeleted: 0, conflicts: 0 };
		} finally {
			this.isSyncing = false;
		}
	}

	// ─── Pull ─────────────────────────────────────────────────────────────────

	async pull(): Promise<SyncResult> {
		if (!this.api) {
			return { success: false, message: 'GitHub not configured', filesUploaded: 0, filesDownloaded: 0, filesDeleted: 0, conflicts: 0 };
		}
		if (this.isSyncing) {
			return { success: false, message: 'Sync already in progress', filesUploaded: 0, filesDownloaded: 0, filesDeleted: 0, conflicts: 0 };
		}
		this.isSyncing = true;
		try {
			new Notice('Pulling from GitHub.');

			// TODO: No retry logic for individual file downloads. A transient network error
			// on any single file aborts the entire pull. Consider retrying failed files.
			const remoteFiles = await this.api.getAllFiles();
			let filesDownloaded = 0;
			let conflicts = 0;

			for (const remoteFile of remoteFiles) {
				if (this.isExcludedPath(remoteFile.path)) continue;

				const content = await this.api.getFileContent(remoteFile.path);
				if (content === null) continue;

				const localFile = this.app.vault.getAbstractFileByPath(normalizePath(remoteFile.path));

				if (localFile instanceof TFile) {
					const { writeRemote, conflictCreated } = await this.resolveConflict(
						this.settings.conflictStrategy,
						localFile,
						content,
						remoteFile.sha
					);
					if (conflictCreated) conflicts++;
					if (writeRemote) {
						await this.writeFileContent(remoteFile.path, content);
						filesDownloaded++;
					}
				} else {
					await this.writeFileContent(remoteFile.path, content);
					filesDownloaded++;
				}

				// Update sync state
				this.settings.syncedFiles[remoteFile.path] = {
					sha: remoteFile.sha,
					mtime: (this.app.vault.getAbstractFileByPath(normalizePath(remoteFile.path)) as TFile | null)?.stat.mtime ?? Date.now()
				};
			}

			new Notice(`GitSync: Pulled ${filesDownloaded} files from GitHub${conflicts > 0 ? `, ${conflicts} conflict(s)` : ''}`);
			return { success: true, message: `Pulled ${filesDownloaded} files`, filesUploaded: 0, filesDownloaded, filesDeleted: 0, conflicts };
		} catch (error) {
			const message = error instanceof Error ? error.message : 'Unknown error';
			new Notice(`GitSync: Pull failed - ${message}`);
			return { success: false, message, filesUploaded: 0, filesDownloaded: 0, filesDeleted: 0, conflicts: 0 };
		} finally {
			this.isSyncing = false;
		}
	}

	// ─── Full sync ────────────────────────────────────────────────────────────

	async sync(): Promise<SyncResult> {
		if (!this.api) {
			return { success: false, message: 'GitHub not configured', filesUploaded: 0, filesDownloaded: 0, filesDeleted: 0, conflicts: 0 };
		}
		if (this.isSyncing) {
			return { success: false, message: 'Sync already in progress', filesUploaded: 0, filesDownloaded: 0, filesDeleted: 0, conflicts: 0 };
		}
		this.isSyncing = true;
		try {
			new Notice('Starting sync.');
			const repoExists = await this.api.ensureRepository();
			if (!repoExists) throw new Error('Could not access or create repository');

			const vaultFiles = this.getVaultFiles();
			const remoteFiles = await this.api.getAllFiles();

			const vaultFileMap = new Map<string, TFile>(vaultFiles.map(f => [f.path, f]));
			const remoteFileMap = new Map<string, GitHubFile>(remoteFiles.map(f => [f.path, f]));

			// Upload all local files
			const filesToUpload: Array<{ path: string; content: string }> = [];
			for (const file of vaultFiles) {
				filesToUpload.push({ path: file.path, content: await this.getFileContent(file) });
			}

			if (filesToUpload.length > 0) {
				// TODO: GitHub Git Data API has a tree-size limit (~100 000 entries). For very large
				// vaults this call will fail. Consider chunking into multiple commits.
				const ok = await this.api.batchUpload(filesToUpload, this.getCommitMessage());
				if (!ok) throw new Error('Failed to upload files');
			}

			let filesDownloaded = 0;
			let conflicts = 0;

			// Download remote-only files and resolve conflicts for files present on both sides
			for (const [path, remoteFile] of remoteFileMap) {
				if (this.isExcludedPath(path)) continue;

				const localFile = vaultFileMap.get(path);
				const content = await this.api.getFileContent(path);
				if (content === null) continue;

				if (localFile) {
					const { writeRemote, conflictCreated } = await this.resolveConflict(
						this.settings.conflictStrategy,
						localFile,
						content,
						remoteFile.sha
					);
					if (conflictCreated) conflicts++;
					if (writeRemote) {
						await this.writeFileContent(path, content);
						filesDownloaded++;
					}
				} else {
					await this.writeFileContent(path, content);
					filesDownloaded++;
				}

				// Update sync state
				const fileOnDisk = this.app.vault.getAbstractFileByPath(normalizePath(path)) as TFile | null;
				this.settings.syncedFiles[path] = {
					sha: remoteFile.sha,
					mtime: fileOnDisk?.stat.mtime ?? Date.now()
				};
			}

			// Record sync state for all uploaded local files
			const freshRemote = await this.api.getAllFiles();
			const freshShaMap = new Map(freshRemote.map(f => [f.path, f.sha]));
			for (const file of vaultFiles) {
				const sha = freshShaMap.get(file.path);
				if (sha) {
					this.settings.syncedFiles[file.path] = { sha, mtime: file.stat.mtime };
				}
			}

			new Notice(`GitSync: Synced ${filesToUpload.length} up, ${filesDownloaded} down${conflicts > 0 ? `, ${conflicts} conflict(s)` : ''}`);
			return {
				success: true,
				message: `Sync complete: ${filesToUpload.length} up, ${filesDownloaded} down`,
				filesUploaded: filesToUpload.length,
				filesDownloaded,
				filesDeleted: 0,
				conflicts
			};
		} catch (error) {
			const message = error instanceof Error ? error.message : 'Unknown error';
			new Notice(`GitSync: Sync failed - ${message}`);
			return { success: false, message, filesUploaded: 0, filesDownloaded: 0, filesDeleted: 0, conflicts: 0 };
		} finally {
			this.isSyncing = false;
		}
	}
}
