// One explicit send per label. An interrupted/ambiguous attempt requires manual reconciliation.
import { promises as fs } from 'node:fs';
const state = process.env.TEAMS_PROBE_STATE;
const topic = process.env.TEAMS_PROBE_GROUP;
const kind = process.env.TEAMS_PROBE_KIND ?? 'group';
if (!['group', 'dm'].includes(kind)) throw new Error('Invalid probe kind');
process.umask(0o077);
try {
  const token = JSON.parse(await fs.readFile(`${state}/credentials.json`, 'utf8'));
  const profiles = JSON.parse(await fs.readFile(`${state}/profiles.local.json`, 'utf8'));
  const identity = JSON.parse(await fs.readFile(`${state}/identity.local.json`, 'utf8'));
  const self = profiles.value?.find(p => p.mri === `8:${identity.skypeName}`);
  if (self?.email?.toLowerCase() !== process.env.TEAMS_PROBE_ACCOUNT?.toLowerCase()) throw new Error('Account mismatch');
  const page = JSON.parse(await fs.readFile(`${state}/conversations.local.json`, 'utf8'));
  const recipient = profiles.value?.find(p => p.email?.toLowerCase() === process.env.TEAMS_PROBE_RECIPIENT?.toLowerCase());
  const chats = page.conversations.filter(c => kind === 'group' ? c.threadProperties?.topic === topic : recipient && c.id.endsWith('@unq.gbl.spaces') && c.id.includes(self.mri.slice(8)) && c.id.includes(recipient.mri.slice(8)));
  if (chats.length !== 1) throw new Error('Chat mismatch');
  if (kind === 'dm') {
    const membersResponse = await fetch(`https://${token.region}.ng.msg.teams.microsoft.com/v1/threads/${encodeURIComponent(chats[0].id)}/members`, { headers: { Authentication: `skypetoken=${token.skypeToken}` }, redirect: 'error', signal: AbortSignal.timeout(20000) });
    if (!membersResponse.ok) throw new Error(`HTTP ${membersResponse.status}`);
    const members = (await membersResponse.json()).members;
    if (!Array.isArray(members) || members.length !== 2 || !members.some(m => m.id === self.mri) || !members.some(m => m.id === recipient.mri)) throw new Error('DM member mismatch');
  }
  const marker = `${state}/${kind}-send-attempt.local.json`;
  const clientmessageid = String(Date.now());
  await fs.writeFile(marker, JSON.stringify({ status: 'sending', chat: chats[0].id, clientmessageid }), { mode: 0o600, flag: 'wx' });
  const content = kind === 'group' ? `OpenClaw Teams transport check: ${self.displayName} can read and send messages here. OpenClaw forwarding is not enabled yet.` : `OpenClaw Teams API transport check: ${self.displayName} can now read and send messages in this DM. OpenClaw forwarding is not enabled yet.`;
  const r = await fetch(`https://${token.region}.ng.msg.teams.microsoft.com/v1/users/ME/conversations/${encodeURIComponent(chats[0].id)}/messages`, {
    method: 'POST', headers: { Authentication: `skypetoken=${token.skypeToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ content, messagetype: 'Text', contenttype: 'text', clientmessageid, imdisplayname: self.displayName, properties: { importance: '', subject: null } }),
    redirect: 'error', signal: AbortSignal.timeout(20000),
  });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  const result = await r.json();
  if (!result.OriginalArrivalTime) throw new Error('Unconfirmed send');
  await fs.writeFile(marker, JSON.stringify({ status: 'confirmed', chat: chats[0].id, clientmessageid, messageId: String(result.OriginalArrivalTime) }), { mode: 0o600 });
  console.log(JSON.stringify({ status: 'confirmed', destination: kind === 'group' ? 'designated-group' : 'authorized-dm' }));
} catch (e) {
  console.error(JSON.stringify({ status: 'stopped-no-retry', category: e.code === 'EEXIST' ? 'attempt-already-recorded' : /^HTTP \d+$/.test(e.message) ? e.message : 'identity-contract-or-uncertain' }));
  process.exitCode = 1;
}
