import { Plugin, Notice } from 'obsidian';
import { GitSyncSettings, DEFAULT_SETTINGS, GitSyncSettingTab } from './settings';
import { SyncService } from './sync-service';

export default class GitSyncPlugin extends Plugin {
	settings: GitSyncSettings;
	syncService: SyncService;
	private autoSyncIntervalId: number | null = null;

	async onload() {
		await this.loadSettings();

		this.syncService = new SyncService(this.app, this.settings);

		this.addRibbonIcon('git-branch', 'Sync with GitHub', async () => {
			if (!this.syncService.isConfigured()) {
				new Notice('Please configure GitHub settings first.');
				return;
			}
			if (this.syncService.isBusy()) {
				new Notice('Sync already in progress.');
				return;
			}
			await this.syncService.sync();
			this.settings.lastSyncTime = Date.now();
			await this.saveSettings();
		});

		this.addCommand({
			id: 'push',
			name: 'Push to GitHub',
			callback: async () => {
				if (!this.syncService.isConfigured()) {
					new Notice('Please configure GitHub settings first.');
					return;
				}
				await this.syncService.push();
				this.settings.lastSyncTime = Date.now();
				await this.saveSettings();
			}
		});

		this.addCommand({
			id: 'pull',
			name: 'Pull from GitHub',
			callback: async () => {
				if (!this.syncService.isConfigured()) {
					new Notice('Please configure GitHub settings first.');
					return;
				}
				await this.syncService.pull();
				this.settings.lastSyncTime = Date.now();
				await this.saveSettings();
			}
		});

		this.addCommand({
			id: 'sync',
			name: 'Sync with GitHub',
			callback: async () => {
				if (!this.syncService.isConfigured()) {
					new Notice('Please configure GitHub settings first.');
					return;
				}
				await this.syncService.sync();
				this.settings.lastSyncTime = Date.now();
				await this.saveSettings();
			}
		});

		this.addCommand({
			id: 'push-current-file',
			name: 'Push current file to GitHub',
			checkCallback: (checking: boolean) => {
				const file = this.app.workspace.getActiveFile();
				if (!file) return false;
				if (!this.syncService.isConfigured()) return false;
				if (checking) return true;
				void (async () => {
					await this.syncService.pushFile(file);
					this.settings.lastSyncTime = Date.now();
					await this.saveSettings();
				})();
				return true;
			}
		});

		this.addSettingTab(new GitSyncSettingTab(this.app, this));
		this.setupAutoSync();

		console.debug('GitSync plugin loaded');
	}

	onunload() {
		this.clearAutoSync();
		console.debug('GitSync plugin unloaded');
	}

	async loadSettings() {
		this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData() as Partial<GitSyncSettings>);
	}

	async saveSettings() {
		await this.saveData(this.settings);
		if (this.syncService) {
			this.syncService.updateSettings(this.settings);
		}
	}

	setupAutoSync() {
		this.clearAutoSync();

		if (this.settings.autoSync && this.syncService.isConfigured()) {
			const intervalMs = this.settings.autoSyncInterval * 60 * 1000;

			this.autoSyncIntervalId = window.setInterval(() => {
				if (!this.syncService.isBusy()) {
					console.debug('GitSync: Running auto-sync...');
					void (async () => {
						await this.syncService.sync();
						this.settings.lastSyncTime = Date.now();
						await this.saveSettings();
					})();
				}
			}, intervalMs);

			this.registerInterval(this.autoSyncIntervalId);
		}
	}

	private clearAutoSync() {
		if (this.autoSyncIntervalId !== null) {
			window.clearInterval(this.autoSyncIntervalId);
			this.autoSyncIntervalId = null;
		}
	}
}
