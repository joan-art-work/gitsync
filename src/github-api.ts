import { requestUrl, RequestUrlParam } from 'obsidian';
import { GitHubFile, GitHubTreeItem } from './types';

export class GitHubAPI {
	private username: string;
	private token: string;
	private repo: string;
	private branch: string;

	constructor(username: string, token: string, repo: string, branch: string = 'main') {
		this.username = username;
		this.token = token;
		this.repo = repo;
		this.branch = branch;
	}

	private get baseUrl(): string {
		return `https://api.github.com/repos/${this.username}/${this.repo}`;
	}

	private get headers(): Record<string, string> {
		return {
			'Authorization': `Bearer ${this.token}`,
			'Accept': 'application/vnd.github+json',
			'X-GitHub-Api-Version': '2022-11-28',
			'Content-Type': 'application/json'
		};
	}

	// TODO: GitHub REST API rate-limits authenticated requests to 5 000/hour. The
	// batch upload flow creates at least 3 API calls (ref + tree + commit) plus one
	// blob per large file. For large vaults with frequent auto-sync this can exhaust
	// the quota. Consider caching the latest commit SHA between operations.
	private async request(url: string, method: string = 'GET', body?: unknown): Promise<unknown> {
		const params: RequestUrlParam = {
			url,
			method,
			headers: this.headers,
			throw: false
		};

		if (body) {
			params.body = JSON.stringify(body);
		}

		const response = await requestUrl(params);

		if (response.status >= 400) {
			const errorMessage = (response.json as { message?: string })?.message || `HTTP ${response.status}`;
			throw new Error(`GitHub API Error: ${errorMessage}`);
		}

		return response.json;
	}

	/**
	 * Verify the token and repository access
	 */
	async verifyAccess(): Promise<boolean> {
		try {
			await this.request(this.baseUrl);
			return true;
		} catch {
			return false;
		}
	}

	/**
	 * Check if repository exists, create if not
	 */
	async ensureRepository(): Promise<boolean> {
		try {
			await this.request(this.baseUrl);
			return true;
		} catch {
			// Repository doesn't exist, try to create it
			try {
				await this.request('https://api.github.com/user/repos', 'POST', {
					name: this.repo,
					private: true,
					auto_init: true,
					description: 'Obsidian vault sync repository'
				});
				return true;
			} catch (createError) {
				console.error('Failed to create repository:', createError);
				return false;
			}
		}
	}

	/**
	 * Get the latest commit SHA for the branch
	 */
	async getLatestCommitSha(): Promise<string | null> {
		try {
			const response = await this.request(`${this.baseUrl}/git/refs/heads/${this.branch}`) as { object: { sha: string } };
			return response.object.sha;
		} catch {
			return null;
		}
	}

	/**
	 * Get the tree SHA from a commit
	 */
	async getTreeSha(commitSha: string): Promise<string> {
		const response = await this.request(`${this.baseUrl}/git/commits/${commitSha}`) as { tree: { sha: string } };
		return response.tree.sha;
	}

	/**
	 * Get all files in the repository
	 */
	async getAllFiles(): Promise<GitHubFile[]> {
		const commitSha = await this.getLatestCommitSha();
		if (!commitSha) {
			return [];
		}

		const treeSha = await this.getTreeSha(commitSha);
		const response = await this.request(`${this.baseUrl}/git/trees/${treeSha}?recursive=1`) as { tree: Array<{ path: string; sha: string; type: string }> };
		
		return response.tree
			.filter((item: { type: string }) => item.type === 'blob')
			.map((item: { path: string; sha: string; type: string }) => ({
				path: item.path,
				sha: item.sha,
				type: 'file' as const
			}));
	}

	/**
	 * Encode a file path for use in GitHub Contents API URLs.
	 * Each segment must be encoded individually — encodeURIComponent on the full path
	 * would turn '/' into '%2F', which GitHub treats as a literal slash in the filename.
	 */
	private encodePath(path: string): string {
		return path.split('/').map(encodeURIComponent).join('/');
	}

	/**
	 * Get file content from GitHub
	 */
	async getFileContent(path: string): Promise<string | null> {
		try {
			const response = await this.request(`${this.baseUrl}/contents/${this.encodePath(path)}?ref=${this.branch}`) as { content: string; encoding: string };
			if (response.content && response.encoding === 'base64') {
				return this.decodeBase64(response.content);
			}
			return null;
		} catch {
			return null;
		}
	}

	/**
	 * Get file SHA (for updating existing files)
	 */
	async getFileSha(path: string): Promise<string | null> {
		try {
			const response = await this.request(`${this.baseUrl}/contents/${this.encodePath(path)}?ref=${this.branch}`) as { sha: string };
			return response.sha;
		} catch {
			return null;
		}
	}

	/**
	 * Create or update a single file
	 */
	async putFile(path: string, content: string, message: string): Promise<boolean> {
		try {
			const sha = await this.getFileSha(path);
			const body: Record<string, string> = {
				message,
				content: this.encodeBase64(content),
				branch: this.branch
			};

			if (sha) {
				body.sha = sha;
			}

			await this.request(`${this.baseUrl}/contents/${this.encodePath(path)}`, 'PUT', body);
			return true;
		} catch (error) {
			console.error(`Failed to upload file ${path}:`, error);
			return false;
		}
	}

	/**
	 * Delete a file from the repository
	 */
	async deleteFile(path: string, message: string): Promise<boolean> {
		try {
			const sha = await this.getFileSha(path);
			if (!sha) {
				return true; // File doesn't exist, consider it deleted
			}

			await this.request(`${this.baseUrl}/contents/${this.encodePath(path)}`, 'DELETE', {
				message,
				sha,
				branch: this.branch
			});
			return true;
		} catch (error) {
			console.error(`Failed to delete file ${path}:`, error);
			return false;
		}
	}

	/**
	 * Create a new tree with multiple files (batch upload)
	 */
	async createTree(baseTreeSha: string | null, items: GitHubTreeItem[]): Promise<string> {
		const body: { tree: GitHubTreeItem[]; base_tree?: string } = { tree: items };
		if (baseTreeSha) {
			body.base_tree = baseTreeSha;
		}

		const response = await this.request(`${this.baseUrl}/git/trees`, 'POST', body) as { sha: string };
		return response.sha;
	}

	/**
	 * Create a new commit
	 */
	async createCommit(message: string, treeSha: string, parentSha: string | null): Promise<string> {
		const body: { message: string; tree: string; parents?: string[] } = {
			message,
			tree: treeSha
		};

		if (parentSha) {
			body.parents = [parentSha];
		}

		const response = await this.request(`${this.baseUrl}/git/commits`, 'POST', body) as { sha: string };
		return response.sha;
	}

	/**
	 * Update branch reference to point to a new commit
	 */
	async updateBranchRef(commitSha: string): Promise<boolean> {
		try {
			await this.request(`${this.baseUrl}/git/refs/heads/${this.branch}`, 'PATCH', {
				sha: commitSha,
				force: true
			});
			return true;
		} catch {
			// Branch might not exist, try to create it
			try {
				await this.request(`${this.baseUrl}/git/refs`, 'POST', {
					ref: `refs/heads/${this.branch}`,
					sha: commitSha
				});
				return true;
			} catch (createError) {
				console.error('Failed to update branch reference:', createError);
				return false;
			}
		}
	}

	/**
	 * Batch upload multiple files using Git Data API (more efficient)
	 *
	 * TODO: The GitHub Git Trees API has an undocumented payload-size limit. Uploading
	 * thousands of files in a single tree POST may return a 422. Consider chunking the
	 * upload into multiple sequential commits when files.length > 500.
	 *
	 * TODO: No retry logic for transient network errors. On iOS, requests can fail mid-
	 * upload due to background suspension. Consider wrapping each request with a small
	 * retry loop (max 3 attempts, exponential back-off).
	 */
	async batchUpload(files: Array<{ path: string; content: string }>, message: string): Promise<boolean> {
		try {
			const commitSha = await this.getLatestCommitSha();
			let baseTreeSha: string | null = null;

			if (commitSha) {
				baseTreeSha = await this.getTreeSha(commitSha);
			}

			// Create blobs for each file and build tree items
			const treeItems: GitHubTreeItem[] = [];

			for (const file of files) {
				// For small files, include content directly
				// For larger files, create a blob first
				if (file.content.length < 100000) {
					treeItems.push({
						path: file.path,
						mode: '100644',
						type: 'blob',
						content: file.content
					});
				} else {
					// Create blob for large files
					const blobResponse = await this.request(`${this.baseUrl}/git/blobs`, 'POST', {
						content: this.encodeBase64(file.content),
						encoding: 'base64'
					}) as { sha: string };

					treeItems.push({
						path: file.path,
						mode: '100644',
						type: 'blob',
						sha: blobResponse.sha
					});
				}
			}

			if (treeItems.length === 0) {
				return true;
			}

			// Create new tree
			const newTreeSha = await this.createTree(baseTreeSha, treeItems);

			// Create new commit
			const newCommitSha = await this.createCommit(message, newTreeSha, commitSha);

			// Update branch reference
			return await this.updateBranchRef(newCommitSha);
		} catch (error) {
			console.error('Batch upload failed:', error);
			return false;
		}
	}

	/**
	 * Encode string to base64 (handles Unicode)
	 */
	private encodeBase64(str: string): string {
		const bytes = new TextEncoder().encode(str);
		let binary = '';
		for (let i = 0; i < bytes.length; i++) {
			binary += String.fromCharCode(bytes[i] as number);
		}
		return btoa(binary);
	}

	/**
	 * Decode base64 to string (handles Unicode)
	 */
	private decodeBase64(base64: string): string {
		const binary = atob(base64.replace(/\n/g, ''));
		const bytes = new Uint8Array(binary.length);
		for (let i = 0; i < binary.length; i++) {
			bytes[i] = binary.charCodeAt(i);
		}
		return new TextDecoder().decode(bytes);
	}
}
