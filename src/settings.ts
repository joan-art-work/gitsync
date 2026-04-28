import { App, PluginSettingTab, Setting, Notice } from 'obsidian';
import GitSyncPlugin from './main';
import { GitSyncSettings, DEFAULT_SETTINGS, ConflictStrategy } from './types';

export type { GitSyncSettings };
export { DEFAULT_SETTINGS };

export class GitSyncSettingTab extends PluginSettingTab {
	plugin: GitSyncPlugin;

	constructor(app: App, plugin: GitSyncPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display(): void {
		const { containerEl } = this;
		containerEl.empty();

		new Setting(containerEl)
			.setName('Configuration')
			.setDesc('Sync your Obsidian vault to a GitHub repository. Works on mobile and desktop.')
			.setHeading();

		// GitHub Account Section
		new Setting(containerEl)
			.setName('GitHub account')
			.setHeading();

		new Setting(containerEl)
			.setName('GitHub username')
			.setDesc('Your GitHub username.')
			.addText(text => text
				.setPlaceholder('Username')
				.setValue(this.plugin.settings.githubUsername)
				.onChange(async (value) => {
					this.plugin.settings.githubUsername = value.trim();
					await this.plugin.saveSettings();
				}));

		new Setting(containerEl)
			.setName('Personal access token')
			.setDesc('Create a token at GitHub settings. Required scopes: repo.')
			.addText(text => {
				text
					.setPlaceholder('Token')
					.setValue(this.plugin.settings.githubToken)
					.onChange(async (value) => {
						this.plugin.settings.githubToken = value.trim();
						await this.plugin.saveSettings();
					});
				text.inputEl.type = 'password';
				return text;
			});

		new Setting(containerEl)
			.setName('Repository name')
			.setDesc('The GitHub repository to sync to. Will be created if it doesn\'t exist.')
			.addText(text => text
				.setPlaceholder('Repository')
				.setValue(this.plugin.settings.repositoryName)
				.onChange(async (value) => {
					this.plugin.settings.repositoryName = value.trim();
					await this.plugin.saveSettings();
				}));

		new Setting(containerEl)
			.setName('Branch name')
			.setDesc('The Git branch to use for syncing.')
			.addText(text => text
				.setPlaceholder('Main')
				.setValue(this.plugin.settings.branch)
				.onChange(async (value) => {
					this.plugin.settings.branch = value.trim() || 'main';
					await this.plugin.saveSettings();
				}));

		// Test Connection Button
		new Setting(containerEl)
			.setName('Test connection')
			.setDesc('Verify your GitHub credentials and repository access.')
			.addButton(button => button
				.setButtonText('Test')
				.setCta()
				.onClick(async () => {
					button.setDisabled(true);
					button.setButtonText('Testing');
					
					const success = await this.plugin.syncService.verifyConnection();
					
					if (success) {
						new Notice('Connection successful.');
					} else {
						new Notice('Connection failed, check your credentials.');
					}
					
					button.setDisabled(false);
					button.setButtonText('Test');
				}));

		// Sync Settings Section
		new Setting(containerEl)
			.setName('Synchronization')
			.setHeading();

		new Setting(containerEl)
			.setName('Auto sync')
			.setDesc('Automatically sync at regular intervals.')
			.addToggle(toggle => toggle
				.setValue(this.plugin.settings.autoSync)
				.onChange(async (value) => {
					this.plugin.settings.autoSync = value;
					await this.plugin.saveSettings();
					this.plugin.setupAutoSync();
				}));

		new Setting(containerEl)
			.setName('Auto sync interval')
			.setDesc('How often to automatically sync (in minutes).')
			.addSlider(slider => slider
				.setLimits(5, 120, 5)
				.setValue(this.plugin.settings.autoSyncInterval)
				.setDynamicTooltip()
				.onChange(async (value) => {
					this.plugin.settings.autoSyncInterval = value;
					await this.plugin.saveSettings();
					this.plugin.setupAutoSync();
				}));

		new Setting(containerEl)
			.setName('Commit message')
			.setDesc('Commit message template. Use {{date}} for current date/time.')
			.addText(text => text
				.setPlaceholder('Obsidian sync: {{date}}')
				.setValue(this.plugin.settings.commitMessage)
				.onChange(async (value) => {
					this.plugin.settings.commitMessage = value || DEFAULT_SETTINGS.commitMessage;
					await this.plugin.saveSettings();
				}));

		new Setting(containerEl)
			.setName('Conflict strategy')
			.setDesc('How to handle files that have changed both locally and on GitHub since the last sync.')
			.addDropdown(drop => drop
				.addOption('newer-wins', 'Newer wins (use most recently modified version)')
				.addOption('local-wins', 'Local wins (always keep local changes)')
				.addOption('remote-wins', 'Remote wins (always take GitHub version)')
				.addOption('duplicate', 'Keep both (save remote as a .conflict copy)')
				.setValue(this.plugin.settings.conflictStrategy)
				.onChange(async (value) => {
					this.plugin.settings.conflictStrategy = value as ConflictStrategy;
					await this.plugin.saveSettings();
				}));

		// Exclusions Section
		new Setting(containerEl)
			.setName('Exclusions')
			.setHeading();

		new Setting(containerEl)
			.setName('Excluded folders')
			.setDesc('Folders to exclude from sync, one per line. Use {{configDir}} for the config folder.')
			.addTextArea(text => {
				text
					.setPlaceholder('{{configDir}}\n.trash')
					.setValue(this.plugin.settings.excludedFolders.join('\n'))
					.onChange(async (value) => {
						this.plugin.settings.excludedFolders = value
							.split('\n')
							.map(s => s.trim())
							.filter(s => s.length > 0);
						await this.plugin.saveSettings();
					});
				text.inputEl.rows = 5;
				text.inputEl.cols = 30;
				return text;
			});

		new Setting(containerEl)
			.setName('Excluded files')
			.setDesc('File names or patterns to exclude, one per line.')
			.addTextArea(text => {
				text
					.setPlaceholder('Example.txt')
					.setValue(this.plugin.settings.excludedFiles.join('\n'))
					.onChange(async (value) => {
						this.plugin.settings.excludedFiles = value
							.split('\n')
							.map(s => s.trim())
							.filter(s => s.length > 0);
						await this.plugin.saveSettings();
					});
				text.inputEl.rows = 3;
				text.inputEl.cols = 30;
				return text;
			});

		// Manual Sync Section
		new Setting(containerEl)
			.setName('Manual sync')
			.setHeading();

		const syncButtonsDiv = containerEl.createDiv({ cls: 'gitsync-buttons' });

		new Setting(syncButtonsDiv)
			.setName('Push to GitHub')
			.setDesc('Upload all local changes to GitHub')
			.addButton(button => button
				.setButtonText('Push')
				.onClick(async () => {
					if (!this.plugin.syncService.isConfigured()) {
						new Notice('Please configure GitHub settings first');
						return;
					}
					await this.plugin.syncService.push();
				}));

		new Setting(syncButtonsDiv)
			.setName('Pull from GitHub')
			.setDesc('Download all changes from GitHub')
			.addButton(button => button
				.setButtonText('Pull')
				.onClick(async () => {
					if (!this.plugin.syncService.isConfigured()) {
						new Notice('Please configure GitHub settings first');
						return;
					}
					await this.plugin.syncService.pull();
				}));

		new Setting(syncButtonsDiv)
			.setName('Full sync')
			.setDesc('Push local changes, then pull remote changes')
			.addButton(button => button
				.setButtonText('Sync')
				.setCta()
				.onClick(async () => {
					if (!this.plugin.syncService.isConfigured()) {
						new Notice('Please configure GitHub settings first');
						return;
					}
					await this.plugin.syncService.sync();
				}));

		// Last Sync Info
		if (this.plugin.settings.lastSyncTime > 0) {
			const lastSync = new Date(this.plugin.settings.lastSyncTime);
			containerEl.createEl('p', {
				text: `Last sync: ${lastSync.toLocaleString()}`,
				cls: 'setting-item-description'
			});
		}
	}
}
