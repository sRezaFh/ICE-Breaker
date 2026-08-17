import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.js';
import { log } from './log.js';

const GITHUB_API = 'https://api.github.com';

type ReleaseAsset = { name: string; url: string };

async function githubRequest(url: string, init: RequestInit): Promise<Response> {
  const res = await fetch(url, {
    ...init,
    headers: {
      Authorization: `Bearer ${config.github.token}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      ...init.headers,
    },
  });
  if (!res.ok) {
    throw new Error(`GitHub API ${res.status} on ${url}: ${await res.text()}`);
  }
  return res;
}

// uploads each saved report as an asset on a new GitHub Release (one release
// per run, tagged by timestamp) - avoids bloating the git history with binary
// diffs the way committing the files directly would
export async function uploadToGitHubRelease(downloadDir: string, fileNames: string[]): Promise<ReleaseAsset[]> {
  const { owner, repo, token } = config.github;
  if (!owner || !repo || !token) {
    throw new Error('GITHUB_TOKEN, GITHUB_OWNER, and GITHUB_REPO must all be set to upload results');
  }
  const tag = `run-${new Date().toISOString().replace(/[:.]/g, '-')}`;

  log.info(`[github] creating release ${tag}`);
  const createRes = await githubRequest(`${GITHUB_API}/repos/${owner}/${repo}/releases`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      tag_name: tag,
      name: `ICE reports - ${tag}`,
      body: `Automated download, ${fileNames.length} file(s).`,
    }),
  });
  const release = (await createRes.json()) as { upload_url: string };
  const uploadUrlBase = release.upload_url.replace('{?name,label}', '');

  const contentTypeFor = (fileName: string): string => {
    switch (path.extname(fileName)) {
      case '.pdf':
        return 'application/pdf';
      case '.html':
        return 'text/html';
      case '.png':
        return 'image/png';
      default:
        return 'application/octet-stream';
    }
  };

  const assets: ReleaseAsset[] = [];
  for (const fileName of fileNames) {
    const filePath = path.join(downloadDir, fileName);
    const fileBuffer = fs.readFileSync(filePath);

    log.info(`[github] uploading ${fileName}`);
    const uploadRes = await githubRequest(`${uploadUrlBase}?name=${encodeURIComponent(fileName)}`, {
      method: 'POST',
      headers: { 'Content-Type': contentTypeFor(fileName) },
      body: fileBuffer,
    });
    const asset = (await uploadRes.json()) as { browser_download_url: string };
    assets.push({ name: fileName, url: asset.browser_download_url });
  }

  return assets;
}
