export type ConflictStrategy = 'local-wins' | 'remote-wins' | 'newer-wins' | 'duplicate';

export interface FileSyncState {
	sha: string;   // GitHub blob SHA at last successful sync
	mtime: number; // Local file mtime (ms) at last successful sync
}

export interface GitSyncSettings {
	githubUsername: string;
	githubToken: string;
	repositoryName: string;
	branch: string;
	autoSync: boolean;
	autoSyncInterval: number; // in minutes
	lastSyncTime: number;
	excludedFolders: string[];
	excludedFiles: string[];
	commitMessage: string;
	conflictStrategy: ConflictStrategy;
	syncedFiles: Record<string, FileSyncState>; // path → state at last sync
}

export const DEFAULT_SETTINGS: GitSyncSettings = {
	githubUsername: '',
	githubToken: '',
	repositoryName: '',
	branch: 'main',
	autoSync: false,
	autoSyncInterval: 30,
	lastSyncTime: 0,
	excludedFolders: ['{{configDir}}/plugins', '{{configDir}}/themes', '.trash'],
	excludedFiles: ['.DS_Store', 'Thumbs.db'],
	commitMessage: 'Obsidian sync: {{date}}',
	conflictStrategy: 'newer-wins',
	syncedFiles: {}
};

export interface GitHubFile {
	path: string;
	sha: string;
	content?: string;
	type: 'file' | 'dir';
}

export interface GitHubTreeItem {
	path: string;
	mode: string;
	type: 'blob' | 'tree';
	sha?: string;
	content?: string;
}

export interface SyncResult {
	success: boolean;
	message: string;
	filesUploaded: number;
	filesDownloaded: number;
	filesDeleted: number;
	conflicts: number;
}
