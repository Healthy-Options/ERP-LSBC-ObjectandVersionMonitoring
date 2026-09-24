/*
 * Dev-tool Object Sync — unattended runner for GitHub Actions.
 *
 * Reads Objects / Object ID / Description / Version out of PRIVATE AL
 * source repos (same GitHub org, different repos from this one) for four
 * sources — Dev-tool, APIs, Cloud-Enhancements, OnPrem-Enhancements —
 * and writes the results into dev-tool-data.json at this repo's root.
 *
 * Runs server-side so the AL_SOURCE_PAT secret below (which needs read
 * access to those other, private repos) never has to sit in browser
 * JavaScript. The app's browser tab only ever reads the *output* file,
 * dev-tool-data.json, via a plain unauthenticated fetch — it never talks
 * to the AL source repos directly.
 *
 * Required repo secret (Settings > Secrets and variables > Actions):
 *   AL_SOURCE_PAT   A GitHub PAT with Contents: Read-only, scoped to
 *                   the AL source repo(s) used by the sources below.
 *
 * dev-tool-data.json's "sources" object (owner/repo/branch/folder per
 * key) is edited from the app itself (Settings > Dev-tool Sync) and
 * committed here before this script ever runs — this script only fills
 * in version / objects / lastSyncedAt for each source, using whatever
 * owner/repo/branch/folder is already on record for it.
 */

const AL_SOURCE_PAT = process.env.AL_SOURCE_PAT;
const fs = require('fs');
const path = require('path');
const DATA_FILE = path.join(process.cwd(), 'dev-tool-data.json');

function fail(msg) {
  console.error(`::error::${msg}`);
  process.exit(1);
}

async function ghApi(owner, repo, apiPath) {
  const res = await fetch(`https://api.github.com/repos/${owner}/${repo}${apiPath}`, {
    headers: { 'Authorization': `Bearer ${AL_SOURCE_PAT}`, 'Accept': 'application/vnd.github+json' },
  });
  const body = await res.json().catch(()=>null);
  if (!res.ok) throw new Error((body && body.message) || `GitHub API error (HTTP ${res.status})`);
  return body;
}
function decodeB64Utf8(b64) { return Buffer.from(b64.replace(/\n/g, ''), 'base64').toString('utf8'); }

const AL_OBJECT_RE = /^\s*(table|tableextension|page|pageextension|pagecustomization|report|reportextension|codeunit|query|xmlport|enum|enumextension|permissionset|permissionsetextension|profile|controladdin|interface)\s+(\d+)\s+"?([^"\r\n{]+?)"?\s*(\{|extends)/gim;
function parseAlObjects(text) {
  const out = []; let m; AL_OBJECT_RE.lastIndex = 0;
  while ((m = AL_OBJECT_RE.exec(text))) out.push({ type: m[1].toLowerCase(), id: Number(m[2]), name: m[3].trim() });
  return out;
}

async function syncOneSource(key, cfg) {
  if (!cfg.owner || !cfg.repo) { console.log(`[${key}] not configured yet — skipping.`); return cfg; }
  const tree = await ghApi(cfg.owner, cfg.repo, `/git/trees/${encodeURIComponent(cfg.branch || 'main')}?recursive=1`);
  const scoped = (tree.tree || []).filter(e => e.type === 'blob' && (!cfg.folder || e.path === cfg.folder || e.path.startsWith(cfg.folder + '/')));
  const entries = scoped.filter(e => e.path.endsWith('.al') || /(^|\/)app\.json$/.test(e.path));
  let appMeta = null;
  const objects = [];
  for (const e of entries) {
    const blob = await ghApi(cfg.owner, cfg.repo, `/git/blobs/${e.sha}`);
    const text = decodeB64Utf8(blob.content);
    if (e.path.endsWith('app.json')) { try { appMeta = JSON.parse(text); } catch (_) {} }
    else objects.push(...parseAlObjects(text));
  }
  const byKey = {};
  objects.forEach(o => { byKey[`${o.type}:${o.id}`] = { objectType: o.type, objectId: o.id, description: o.name }; });
  console.log(`[${key}] ${cfg.owner}/${cfg.repo}@${cfg.branch || 'main'} — ${Object.keys(byKey).length} object(s)${appMeta && appMeta.version ? `, version ${appMeta.version}` : ''}`);
  return {
    owner: cfg.owner, repo: cfg.repo, branch: cfg.branch || 'main', folder: cfg.folder || '',
    version: (appMeta && appMeta.version) || cfg.version || null,
    objects: Object.values(byKey),
    lastSyncedAt: new Date().toISOString(),
  };
}

async function main() {
  if (!AL_SOURCE_PAT) fail('Missing AL_SOURCE_PAT secret.');
  if (!fs.existsSync(DATA_FILE)) fail(`${DATA_FILE} not found — save the connection config from the app first (Settings > Dev-tool Sync > Save Connection).`);
  const data = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
  data.sources = data.sources || {};
  let lastRunError = '';
  for (const key of Object.keys(data.sources)) {
    try {
      data.sources[key] = await syncOneSource(key, data.sources[key]);
    } catch (err) {
      lastRunError += `[${key}] ${err.message}\n`;
      console.error(`::warning::${key} sync failed: ${err.message}`);
    }
  }
  data.lastRunAt = new Date().toISOString();
  data.lastRunStatus = lastRunError ? 'error' : 'success';
  data.lastRunError = lastRunError.trim();
  fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2));
  if (lastRunError) fail(`One or more sources failed:\n${lastRunError}`);
}

main();
