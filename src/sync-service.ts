import { App, TFile, Notice, normalizePath } from 'obsidian';
import { GitHubAPI } from './github-api';
import { GitSyncSettings, SyncResult, GitHubFile, ConflictStrategy } from './types';

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

	private isBinaryExtension(path: string): boolean {
		const ext = path.split('.').pop()?.toLowerCase() ?? '';
		return this.BINARY_EXTENSIONS.has(ext);
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

	private normalizeLineEndings(content: string): string {
		return content.replace(/\r\n/g, '\n');
	}

	/**
	 * Compute the git blob SHA-1 for a given string content.
	 * Formula: sha1("blob N\0" + content_utf8) where N is the UTF-8 byte length.
	 * This matches GitHub's blob SHA exactly, so we can compare against stored SHAs
	 * without making any API calls.
	 */
	private async computeGitBlobSha(content: string): Promise<string> {
		const encoder = new TextEncoder();
		const contentBytes = encoder.encode(content);
		const header = encoder.encode(`blob ${contentBytes.length}\0`);
		const data = new Uint8Array(header.length + contentBytes.length);
		data.set(header);
		data.set(contentBytes, header.length);
		const hashBuffer = await crypto.subtle.digest('SHA-1', data);
		return Array.from(new Uint8Array(hashBuffer))
			.map(b => b.toString(16).padStart(2, '0'))
			.join('');
	}

	/**
	 * Returns true if the file content differs from what was last synced.
	 * For text files, content must already be CRLF-normalized before calling.
	 * Binary files rely on mtime only (their content format is opaque).
	 */
	private async hasContentChanged(file: TFile, normalizedContent: string): Promise<boolean> {
		const lastSync = this.settings.syncedFiles[file.path];
		if (!lastSync) return true; // never synced → always push
		if (file.stat.mtime <= lastSync.mtime) return false; // mtime unchanged → skip
		if (this.isBinaryFile(file)) return true; // binary: trust mtime alone
		const sha = await this.computeGitBlobSha(normalizedContent);
		return sha !== lastSync.sha; // CRLF-only diff → SHAs match → skip
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

	// ─── Move detection ───────────────────────────────────────────────────────

	/**
	 * Jaccard similarity over non-empty trimmed lines (0 = no overlap, 1 = identical).
	 * Used as a fallback when the git rename API and SHA matching both fail.
	 */
	contentSimilarity(a: string, b: string): number {
		const toLines = (s: string) =>
			new Set(s.split('\n').map(l => l.trim()).filter(l => l.length > 0));
		const linesA = toLines(a);
		const linesB = toLines(b);
		if (linesA.size === 0 && linesB.size === 0) return 1;
		if (linesA.size === 0 || linesB.size === 0) return 0;
		const intersection = [...linesA].filter(l => linesB.has(l)).length;
		const union = new Set([...linesA, ...linesB]).size;
		return intersection / union;
	}

	/**
	 * Detect remote file moves in three phases:
	 *
	 * Phase 0 — GitHub Compare API (git-native rename detection, 100% accurate).
	 *   Compares lastSyncedCommitSha..currentHead. Falls back silently if the
	 *   base commit is missing (squash, force-push, first sync).
	 *
	 * Phase 1 — Exact blob SHA match against syncedFiles (100% accurate, free).
	 *   Catches moves that git didn't surface (e.g. cross-commit moves) where
	 *   the content was not modified.
	 *
	 * Phase 2 — Jaccard line similarity on text files (≥ 0.5 threshold).
	 *   Handles moves where the file was also edited. Capped at 20 candidates
	 *   on each side to limit extra API calls on large vaults.
	 */
	async detectMoves(
		currentHeadSha: string,
		remoteFiles: GitHubFile[],
		localFileMap: Map<string, TFile>
	): Promise<Array<{ oldPath: string; newPath: string; contentChanged: boolean }>> {
		const syncedPaths = new Set(Object.keys(this.settings.syncedFiles));
		const remotePaths = new Set(remoteFiles.map(f => f.path));

		// Files present at last sync but gone from remote (potentially moved away)
		const missingRemotely = [...syncedPaths].filter(
			p => !remotePaths.has(p) && localFileMap.has(p)
		);
		// Files now on remote that weren't at last sync (potentially moved to)
		const newRemotely = remoteFiles.filter(f => !syncedPaths.has(f.path));

		if (missingRemotely.length === 0 || newRemotely.length === 0) return [];

		type Move = { oldPath: string; newPath: string; contentChanged: boolean };
		const moves: Move[] = [];
		const matchedNew = new Set<string>();
		const matchedOld = new Set<string>();

		// ── Phase 0: git-native renames via Compare API ───────────────────────
		if (this.api && this.settings.lastSyncedCommitSha) {
			const gitRenames = await this.api.getRenamedFiles(
				this.settings.lastSyncedCommitSha,
				currentHeadSha
			);
			for (const { oldPath, newPath } of gitRenames) {
				if (!localFileMap.has(oldPath)) continue;
				if (!remotePaths.has(newPath)) continue;
				// A rename may also have content changes — check SHAs to know
				const oldSha = this.settings.syncedFiles[oldPath]?.sha ?? '';
				const newSha = remoteFiles.find(f => f.path === newPath)?.sha ?? '';
				moves.push({ oldPath, newPath, contentChanged: oldSha !== newSha });
				matchedNew.add(newPath);
				matchedOld.add(oldPath);
			}
		}

		// ── Phase 1: exact blob SHA match ─────────────────────────────────────
		const oldShaToPath = new Map<string, string>();
		for (const p of missingRemotely) {
			if (matchedOld.has(p)) continue;
			const sha = this.settings.syncedFiles[p]?.sha;
			if (sha) oldShaToPath.set(sha, p);
		}
		for (const newFile of newRemotely) {
			if (matchedNew.has(newFile.path)) continue;
			const oldPath = oldShaToPath.get(newFile.sha);
			if (oldPath) {
				moves.push({ oldPath, newPath: newFile.path, contentChanged: false });
				matchedNew.add(newFile.path);
				matchedOld.add(oldPath);
			}
		}

		// ── Phase 2: Jaccard content similarity (text files, ≤ 20 × 20) ──────
		const fuzzyOld = missingRemotely
			.filter(p => !matchedOld.has(p) && !this.isBinaryExtension(p))
			.slice(0, 20);
		const fuzzyNew = newRemotely
			.filter(f => !matchedNew.has(f.path) && !this.isBinaryExtension(f.path))
			.slice(0, 20);

		if (fuzzyOld.length > 0 && fuzzyNew.length > 0 && this.api) {
			const remoteContents = new Map<string, string>();
			for (const f of fuzzyNew) {
				const c = await this.api.getFileContent(f.path);
				if (c !== null) remoteContents.set(f.path, c);
			}
			const localContents = new Map<string, string>();
			for (const p of fuzzyOld) {
				const file = localFileMap.get(p);
				if (!file) continue;
				try { localContents.set(p, await this.app.vault.read(file)); } catch { /* skip */ }
			}

			for (const oldPath of fuzzyOld) {
				const oldContent = localContents.get(oldPath);
				if (!oldContent) continue;
				let bestPath = '';
				let bestScore = 0;
				for (const [newPath, newContent] of remoteContents) {
					if (matchedNew.has(newPath)) continue;
					const score = this.contentSimilarity(oldContent, newContent);
					if (score > 0.5 && score > bestScore) {
						bestScore = score;
						bestPath = newPath;
					}
				}
				if (bestPath) {
					moves.push({ oldPath, newPath: bestPath, contentChanged: true });
					matchedNew.add(bestPath);
					matchedOld.add(oldPath);
				}
			}
		}

		return moves;
	}

	/**
	 * Apply detected moves: rename files in the vault, update their content if
	 * needed, and refresh syncedFiles. Returns the number of moves applied.
	 */
	private async applyMoves(
		moves: Array<{ oldPath: string; newPath: string; contentChanged: boolean }>,
		remoteFileMap: Map<string, GitHubFile>
	): Promise<number> {
		let count = 0;
		for (const { oldPath, newPath, contentChanged } of moves) {
			const localFile = this.app.vault.getAbstractFileByPath(normalizePath(oldPath));
			if (!(localFile instanceof TFile)) continue;
			try {
				await this.ensureFolder(newPath);
				await this.app.vault.rename(localFile, newPath);
				count++;

				if (contentChanged && this.api) {
					const content = await this.api.getFileContent(newPath);
					if (content !== null) {
						const moved = this.app.vault.getAbstractFileByPath(normalizePath(newPath));
						if (moved instanceof TFile) await this.app.vault.modify(moved, content);
					}
				}

				// Update sync state: drop old path, record new path
				delete this.settings.syncedFiles[oldPath];
				const remoteFile = remoteFileMap.get(newPath);
				if (remoteFile) {
					const movedFile = this.app.vault.getAbstractFileByPath(normalizePath(newPath));
					this.settings.syncedFiles[newPath] = {
						sha: remoteFile.sha,
						mtime: (movedFile instanceof TFile ? movedFile.stat.mtime : null) ?? Date.now()
					};
				}

				new Notice(`GitSync: Déplacé ${oldPath.split('/').pop()} → ${newPath}`);
			} catch (err) {
				console.error(`GitSync: move failed ${oldPath} → ${newPath}:`, err);
			}
		}
		return count;
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
			return { success: false, message: 'GitHub not configured', filesUploaded: 0, filesDownloaded: 0, filesDeleted: 0, conflicts: 0, filesMoved: 0 };
		}
		if (this.isSyncing) {
			return { success: false, message: 'Sync already in progress', filesUploaded: 0, filesDownloaded: 0, filesDeleted: 0, conflicts: 0, filesMoved: 0 };
		}
		this.isSyncing = true;
		try {
			new Notice('Pushing to GitHub.');
			const repoExists = await this.api.ensureRepository();
			if (!repoExists) throw new Error('Could not access or create repository');

			const vaultFiles = this.getVaultFiles();
			const filesToUpload: Array<{ path: string; content: string }> = [];
			for (const file of vaultFiles) {
				const raw = await this.getFileContent(file);
				const content = this.isBinaryFile(file) ? raw : this.normalizeLineEndings(raw);
				if (!await this.hasContentChanged(file, content)) continue;
				filesToUpload.push({ path: file.path, content });
			}

			if (filesToUpload.length === 0) {
				new Notice('GitSync: nothing to push');
				return { success: true, message: 'Nothing to push', filesUploaded: 0, filesDownloaded: 0, filesDeleted: 0, conflicts: 0, filesMoved: 0 };
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
			return { success: true, message: `Pushed ${filesToUpload.length} files`, filesUploaded: filesToUpload.length, filesDownloaded: 0, filesDeleted: 0, conflicts: 0, filesMoved: 0 };
		} catch (error) {
			const message = error instanceof Error ? error.message : 'Unknown error';
			new Notice(`GitSync: Push failed - ${message}`);
			return { success: false, message, filesUploaded: 0, filesDownloaded: 0, filesDeleted: 0, conflicts: 0, filesMoved: 0 };
		} finally {
			this.isSyncing = false;
		}
	}

	// ─── Push single file ─────────────────────────────────────────────────────

	async pushFile(file: TFile): Promise<SyncResult> {
		if (!this.api) {
			return { success: false, message: 'GitHub not configured', filesUploaded: 0, filesDownloaded: 0, filesDeleted: 0, conflicts: 0, filesMoved: 0 };
		}
		// TODO: isBusy check uses a single boolean; it does not distinguish between a full
		// sync in progress and a single-file push, so a pushFile cannot run concurrently
		// with itself. Consider a per-file lock map for finer-grained control.
		if (this.isSyncing) {
			return { success: false, message: 'Sync already in progress', filesUploaded: 0, filesDownloaded: 0, filesDeleted: 0, conflicts: 0, filesMoved: 0 };
		}
		if (this.isExcluded(file.path, file.name)) {
			return { success: false, message: 'File is excluded from sync', filesUploaded: 0, filesDownloaded: 0, filesDeleted: 0, conflicts: 0, filesMoved: 0 };
		}
		this.isSyncing = true;
		try {
			new Notice(`GitSync: Pushing ${file.name}…`);
			const raw = await this.getFileContent(file);
			const content = this.isBinaryFile(file) ? raw : this.normalizeLineEndings(raw);
			if (!await this.hasContentChanged(file, content)) {
				new Notice(`GitSync: ${file.name} — aucune modification`);
				return { success: true, message: `${file.name} already up to date`, filesUploaded: 0, filesDownloaded: 0, filesDeleted: 0, conflicts: 0, filesMoved: 0 };
			}
			const success = await this.api.putFile(file.path, content, this.getCommitMessage());
			if (!success) throw new Error(`Failed to upload ${file.name}`);

			// Update sync state for this file
			const sha = await this.api.getFileSha(file.path);
			if (sha) {
				this.settings.syncedFiles[file.path] = { sha, mtime: file.stat.mtime };
			}

			new Notice(`GitSync: Pushed ${file.name}`);
			return { success: true, message: `Pushed ${file.name}`, filesUploaded: 1, filesDownloaded: 0, filesDeleted: 0, conflicts: 0, filesMoved: 0 };
		} catch (error) {
			const message = error instanceof Error ? error.message : 'Unknown error';
			new Notice(`GitSync: Push failed - ${message}`);
			return { success: false, message, filesUploaded: 0, filesDownloaded: 0, filesDeleted: 0, conflicts: 0, filesMoved: 0 };
		} finally {
			this.isSyncing = false;
		}
	}

	// ─── Pull ─────────────────────────────────────────────────────────────────

	async pull(): Promise<SyncResult> {
		if (!this.api) {
			return { success: false, message: 'GitHub not configured', filesUploaded: 0, filesDownloaded: 0, filesDeleted: 0, conflicts: 0, filesMoved: 0 };
		}
		if (this.isSyncing) {
			return { success: false, message: 'Sync already in progress', filesUploaded: 0, filesDownloaded: 0, filesDeleted: 0, conflicts: 0, filesMoved: 0 };
		}
		this.isSyncing = true;
		try {
			new Notice('Pulling from GitHub.');

			// TODO: No retry logic for individual file downloads. A transient network error
			// on any single file aborts the entire pull. Consider retrying failed files.
			const currentHeadSha = await this.api.getLatestCommitSha() ?? '';
			const remoteFiles = await this.api.getAllFiles();
			const remoteFileMap = new Map<string, GitHubFile>(remoteFiles.map(f => [f.path, f]));

			// Build a full local map (not filtered) so move detection can find any file
			const allLocalFiles = new Map<string, TFile>(
				this.app.vault.getFiles().map(f => [f.path, f])
			);

			// Detect and apply moves before the normal download pass
			const moves = await this.detectMoves(currentHeadSha, remoteFiles, allLocalFiles);
			const filesMoved = await this.applyMoves(moves, remoteFileMap);
			const movedNewPaths = new Set(moves.map(m => m.newPath));

			let filesDownloaded = 0;
			let conflicts = 0;

			for (const remoteFile of remoteFiles) {
				if (this.isExcludedPath(remoteFile.path)) continue;
				// Skip files already handled by move detection
				if (movedNewPaths.has(remoteFile.path)) continue;

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

				this.settings.syncedFiles[remoteFile.path] = {
					sha: remoteFile.sha,
					mtime: (this.app.vault.getAbstractFileByPath(normalizePath(remoteFile.path)) as TFile | null)?.stat.mtime ?? Date.now()
				};
			}

			// Persist the HEAD SHA so the next pull can use the Compare API
			this.settings.lastSyncedCommitSha = currentHeadSha;

			const parts = [
				`${filesDownloaded} fichier(s) téléchargé(s)`,
				filesMoved > 0 ? `${filesMoved} déplacé(s)` : '',
				conflicts > 0 ? `${conflicts} conflit(s)` : ''
			].filter(Boolean).join(', ');
			new Notice(`GitSync: Pull — ${parts}`);
			return { success: true, message: `Pulled ${filesDownloaded} files, ${filesMoved} moved`, filesUploaded: 0, filesDownloaded, filesDeleted: 0, conflicts, filesMoved };
		} catch (error) {
			const message = error instanceof Error ? error.message : 'Unknown error';
			new Notice(`GitSync: Pull failed - ${message}`);
			return { success: false, message, filesUploaded: 0, filesDownloaded: 0, filesDeleted: 0, conflicts: 0, filesMoved: 0 };
		} finally {
			this.isSyncing = false;
		}
	}

	// ─── Full sync ────────────────────────────────────────────────────────────

	async sync(): Promise<SyncResult> {
		if (!this.api) {
			return { success: false, message: 'GitHub not configured', filesUploaded: 0, filesDownloaded: 0, filesDeleted: 0, conflicts: 0, filesMoved: 0 };
		}
		if (this.isSyncing) {
			return { success: false, message: 'Sync already in progress', filesUploaded: 0, filesDownloaded: 0, filesDeleted: 0, conflicts: 0, filesMoved: 0 };
		}
		this.isSyncing = true;
		try {
			new Notice('Starting sync.');
			const repoExists = await this.api.ensureRepository();
			if (!repoExists) throw new Error('Could not access or create repository');

			const vaultFiles = this.getVaultFiles();
			const remoteFiles = await this.api.getAllFiles();
			const currentHeadSha = await this.api.getLatestCommitSha() ?? '';

			const vaultFileMap = new Map<string, TFile>(vaultFiles.map(f => [f.path, f]));
			const remoteFileMap = new Map<string, GitHubFile>(remoteFiles.map(f => [f.path, f]));

			// Detect and apply remote moves before upload/download
			const allLocalFiles = new Map<string, TFile>(
				this.app.vault.getFiles().map(f => [f.path, f])
			);
			const moves = await this.detectMoves(currentHeadSha, remoteFiles, allLocalFiles);
			const filesMoved = await this.applyMoves(moves, remoteFileMap);
			const movedNewPaths = new Set(moves.map(m => m.newPath));

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
				if (movedNewPaths.has(path)) continue;

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

			// Record sync state for all uploaded local files and persist HEAD SHA
			const freshRemote = await this.api.getAllFiles();
			const freshShaMap = new Map(freshRemote.map(f => [f.path, f.sha]));
			for (const file of vaultFiles) {
				const sha = freshShaMap.get(file.path);
				if (sha) {
					this.settings.syncedFiles[file.path] = { sha, mtime: file.stat.mtime };
				}
			}
			const finalHeadSha = await this.api.getLatestCommitSha() ?? '';
			this.settings.lastSyncedCommitSha = finalHeadSha;

			new Notice(`GitSync: Synced ${filesToUpload.length} up, ${filesDownloaded} down${filesMoved > 0 ? `, ${filesMoved} moved` : ''}${conflicts > 0 ? `, ${conflicts} conflict(s)` : ''}`);
			return {
				success: true,
				message: `Sync complete: ${filesToUpload.length} up, ${filesDownloaded} down`,
				filesUploaded: filesToUpload.length,
				filesDownloaded,
				filesDeleted: 0,
				conflicts,
				filesMoved
			};
		} catch (error) {
			const message = error instanceof Error ? error.message : 'Unknown error';
			new Notice(`GitSync: Sync failed - ${message}`);
			return { success: false, message, filesUploaded: 0, filesDownloaded: 0, filesDeleted: 0, conflicts: 0, filesMoved: 0 };
		} finally {
			this.isSyncing = false;
		}
	}
}
