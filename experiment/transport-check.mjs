// Bounded manual probe. Tokens and raw responses never go to stdout.
import { captureFromBrowser } from '../dist/src/login.js';
import { promises as fs } from 'node:fs';
import path from 'node:path';

const state = process.env.TEAMS_PROBE_STATE;
if (!state || !path.isAbsolute(state)) throw new Error('Set an absolute TEAMS_PROBE_STATE');
process.umask(0o077);
const dir = await fs.lstat(state);
if (!dir.isDirectory() || dir.isSymbolicLink() || (dir.mode & 0o077) || dir.uid !== process.getuid()) {
  throw new Error('State must be owned by this account and mode 0700');
}
// All probe writes and reads above are awaited before this bounded exit.
process.exit(process.exitCode ?? 0);
const write = async (name, data) => {
  const target = path.join(state, name);
  const temporary = `${target}.${process.pid}.tmp`;
  await fs.writeFile(temporary, JSON.stringify(data), { mode: 0o600, flag: 'wx' });
  await fs.rename(temporary, target);
};
try {
  const token = await captureFromBrowser(9222);
  if (!/^[a-z0-9-]+$/.test(token.region) || !token.skypeToken) throw new Error('Invalid token shape');
  await write('credentials.json', token);
  const base = new URL(`https://${token.region}.ng.msg.teams.microsoft.com/v1/`);
  const get = async (relative) => {
    const url = new URL(relative, base);
    if (url.origin !== base.origin || !url.pathname.startsWith(base.pathname)) throw new Error('Unsafe URL');
    const response = await fetch(url, {
      headers: { Authentication: `skypetoken=${token.skypeToken}` },
      redirect: 'error', signal: AbortSignal.timeout(20_000),
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return response.json();
  };
  const identity = await get('users/ME/properties');
  await write('identity.local.json', identity);
  const page = await get('users/ME/conversations?view=mychats&pageSize=100');
  if (!Array.isArray(page.conversations)) throw new Error('Invalid conversations shape');
  await write('conversations.local.json', page);
  console.log(JSON.stringify({ status: 'captured', identityKeys: Object.keys(identity), conversations: page.conversations.length, morePages: Boolean(page._metadata?.backwardLink) }));
} catch (error) {
  // Raw dependency errors can contain URLs, response bodies or credentials.
  console.error(JSON.stringify({ status: 'failed', category: error instanceof Error && /^HTTP \d+$/.test(error.message) ? error.message : 'login-or-contract-check' }));
  process.exitCode = 1;
}
