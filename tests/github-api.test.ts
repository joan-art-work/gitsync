import { describe, it, expect, vi } from 'vitest';

// GitHubAPI imports { requestUrl, RequestUrlParam } from 'obsidian'.
// Provide a minimal stub so the module resolves in a Node environment.
vi.mock('obsidian', () => ({
	requestUrl: vi.fn()
}));

import { GitHubAPI } from '../src/github-api';

// ── helpers ────────────────────────────────────────────────────────────────

/** Build a minimal GitHubAPI instance pointing at a fake repo. */
function makeAPI() {
	return new GitHubAPI('user', 'token', 'repo', 'main');
}

/**
 * Access the private `encodePath` method via bracket notation so we can test
 * the path-encoding fix without going through a full HTTP round-trip.
 */
function encodePath(api: GitHubAPI, path: string): string {
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	return (api as any).encodePath(path) as string;
}

function encodeBase64(api: GitHubAPI, str: string): string {
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	return (api as any).encodeBase64(str) as string;
}

function decodeBase64(api: GitHubAPI, str: string): string {
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	return (api as any).decodeBase64(str) as string;
}

// ── encodePath ─────────────────────────────────────────────────────────────
//
// Bug: the old code called encodeURIComponent on the full path, turning
// "notes/readme.md" into "notes%2Freadme.md" — GitHub then looks for a file
// *named* "notes/readme.md" at the root, which doesn't exist.
// Fix: encode each segment individually and re-join with '/'.

describe('GitHubAPI.encodePath', () => {
	it('preserves path separators', () => {
		const api = makeAPI();
		expect(encodePath(api, 'notes/readme.md')).toBe('notes/readme.md');
	});

	it('encodes spaces in each segment', () => {
		const api = makeAPI();
		expect(encodePath(api, 'my notes/my file.md')).toBe('my%20notes/my%20file.md');
	});

	it('encodes special chars but not slashes', () => {
		const api = makeAPI();
		const result = encodePath(api, 'work/[2024] project/summary.md');
		// slashes stay; brackets are encoded
		expect(result).toBe('work/%5B2024%5D%20project/summary.md');
	});

	it('handles root-level files', () => {
		const api = makeAPI();
		expect(encodePath(api, 'README.md')).toBe('README.md');
	});

	it('handles deeply nested paths', () => {
		const api = makeAPI();
		expect(encodePath(api, 'a/b/c/d.md')).toBe('a/b/c/d.md');
	});

	it('does NOT encode slashes as %2F (regression for iOS pull bug)', () => {
		const api = makeAPI();
		const result = encodePath(api, 'notes/work/project.md');
		expect(result).not.toContain('%2F');
	});
});

// ── base64 round-trip ──────────────────────────────────────────────────────

describe('GitHubAPI base64 encoding', () => {
	it('round-trips ASCII text', () => {
		const api = makeAPI();
		const text = 'Hello, world!';
		expect(decodeBase64(api, encodeBase64(api, text))).toBe(text);
	});

	it('round-trips Unicode text (emojis, CJK)', () => {
		const api = makeAPI();
		const text = '日本語テスト 🎉 Ünïcödé';
		expect(decodeBase64(api, encodeBase64(api, text))).toBe(text);
	});

	it('decodeBase64 strips newlines in GitHub-returned content', () => {
		const api = makeAPI();
		const original = 'Hello, world!';
		const encoded = btoa(original);
		const withNewlines = encoded.match(/.{1,64}/g)?.join('\n') ?? encoded;
		expect(decodeBase64(api, withNewlines)).toBe(original);
	});
});

// ── verifyAccess ───────────────────────────────────────────────────────────

describe('GitHubAPI.verifyAccess', () => {
	it('returns true when the repo request succeeds', async () => {
		const api = makeAPI();
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		vi.spyOn(api as any, 'request').mockResolvedValueOnce({ id: 1 });
		expect(await api.verifyAccess()).toBe(true);
	});

	it('returns false on any error', async () => {
		const api = makeAPI();
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		vi.spyOn(api as any, 'request').mockRejectedValueOnce(new Error('401'));
		expect(await api.verifyAccess()).toBe(false);
	});
});

// ── getFileSha ─────────────────────────────────────────────────────────────

describe('GitHubAPI.getFileSha', () => {
	it('returns the sha when the file exists', async () => {
		const api = makeAPI();
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		vi.spyOn(api as any, 'request').mockResolvedValueOnce({ sha: 'abc123' });
		expect(await api.getFileSha('notes/readme.md')).toBe('abc123');
	});

	it('returns null when the file does not exist', async () => {
		const api = makeAPI();
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		vi.spyOn(api as any, 'request').mockRejectedValueOnce(new Error('404'));
		expect(await api.getFileSha('missing.md')).toBeNull();
	});
});

// ── putFile ────────────────────────────────────────────────────────────────

describe('GitHubAPI.putFile', () => {
	it('includes sha in body when file already exists', async () => {
		const api = makeAPI();
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		const spy = vi.spyOn(api as any, 'request');
		spy.mockResolvedValueOnce({ sha: 'existing-sha' }); // getFileSha
		spy.mockResolvedValueOnce({ content: { sha: 'new-sha' } }); // PUT

		await api.putFile('notes/file.md', 'content', 'commit msg');

		const [, , body] = spy.mock.calls[1] as [string, string, Record<string, string>];
		expect(body.sha).toBe('existing-sha');
	});

	it('omits sha in body when file is new', async () => {
		const api = makeAPI();
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		const spy = vi.spyOn(api as any, 'request');
		spy.mockResolvedValueOnce(null); // getFileSha returns null via catch → need to reject
		spy.mockImplementationOnce(async () => { throw new Error('404'); }); // getFileSha throws
		spy.mockResolvedValueOnce({ content: { sha: 'new-sha' } }); // PUT

		// Reset: use proper flow
		spy.mockReset();
		vi.spyOn(api, 'getFileSha').mockResolvedValueOnce(null);
		spy.mockResolvedValueOnce({ content: { sha: 'new-sha' } }); // PUT request

		await api.putFile('new-file.md', 'content', 'commit msg');

		const [, , body] = spy.mock.calls[0] as [string, string, Record<string, string>];
		expect(body.sha).toBeUndefined();
	});
});
