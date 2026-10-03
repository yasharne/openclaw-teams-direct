import { promises as fs } from 'node:fs';
const state = process.env.TEAMS_PROBE_STATE;
const token = JSON.parse(await fs.readFile(`${state}/credentials.json`, 'utf8'));
const identity = JSON.parse(await fs.readFile(`${state}/identity.local.json`, 'utf8'));
const page = JSON.parse(await fs.readFile(`${state}/conversations.local.json`, 'utf8'));
const group = page.conversations.filter(c => c.threadProperties?.topic === process.env.TEAMS_PROBE_GROUP);
if (group.length !== 1) throw new Error('Designated group must resolve uniquely');
const base = `https://${token.region}.ng.msg.teams.microsoft.com/v1/`;
const get = async relative => {
  const r = await fetch(new URL(relative, base), { headers: { Authentication: `skypetoken=${token.skypeToken}` }, redirect: 'error', signal: AbortSignal.timeout(20000) });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.json();
};
try {
  const members = await get(`threads/${encodeURIComponent(group[0].id)}/members`);
  if (!Array.isArray(members.members) || !token.bearerToken) throw new Error('Missing members/profile token');
  const ids = [...new Set([`8:${identity.skypeName}`, ...members.members.map(m => m.id)])];
  const r = await fetch(`https://teams.cloud.microsoft/api/mt/${token.region}/beta/users/fetchShortProfile?isMailAddress=false&enableGuest=true&skypeTeamsInfo=true`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token.bearerToken}` }, body: JSON.stringify(ids), redirect: 'error', signal: AbortSignal.timeout(20000),
  });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  const profiles = await r.json();
  await fs.writeFile(`${state}/profiles.local.json`, JSON.stringify(profiles), { mode: 0o600 });
  const messages = await get(`users/ME/conversations/${encodeURIComponent(group[0].id)}/messages?pageSize=20`);
  await fs.writeFile(`${state}/group-messages.local.json`, JSON.stringify(messages), { mode: 0o600 });
  console.log(JSON.stringify({ profiles: (profiles.value ?? []).map(p => ({ mri: p.mri, displayName: p.displayName, email: p.email })), members: members.members.length, messages: messages.messages?.length, messageTypes: [...new Set((messages.messages ?? []).map(m => m.messagetype))] }));
} catch (e) {
  console.error(JSON.stringify({ status: 'failed', category: /^HTTP \d+$/.test(e.message) ? e.message : 'contract-check' }));
  process.exitCode = 1;
}
