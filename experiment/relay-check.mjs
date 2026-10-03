// Bounded live acceptance: one new authorized DM and one prefixed group turn.
// This is not the durable production worker. Interrupted external calls stop.
import { promises as fs } from 'node:fs';
import { createHash } from 'node:crypto';
import { decodeHTML } from 'entities';

process.umask(0o077);
const state = process.env.TEAMS_PROBE_STATE;
const read = async name => JSON.parse(await fs.readFile(`${state}/${name}`, 'utf8'));
const save = async (name, value) => {
  const target = `${state}/${name}`;
  await fs.writeFile(`${target}.tmp`, JSON.stringify(value), { mode: 0o600 });
  await fs.rename(`${target}.tmp`, target);
};
const token = await read('credentials.json');
const openclaw = await read('openclaw-secret.local.json');
const config = await read('relay-config.local.json');
const profiles = (await read('profiles.local.json')).value;
const identity = await read('identity.local.json');
const self = profiles.filter(p => p.mri === `8:${identity.skypeName}` && p.email?.toLowerCase() === config.accountEmail.toLowerCase());
const sender = profiles.filter(p => p.email?.toLowerCase() === config.recipientEmail.toLowerCase());
if (self.length !== 1 || sender.length !== 1) throw new Error('Account or sender not unique');
if (!/^[a-z0-9-]+$/.test(token.region)) throw new Error('Invalid region');
const base = new URL(`https://${token.region}.ng.msg.teams.microsoft.com/v1/`);
const request = async (relative, body) => {
  const url = new URL(relative, base);
  if (url.origin !== base.origin || !url.pathname.startsWith(base.pathname) || url.username || url.password) throw new Error('Unsafe paging URL');
  const r = await fetch(url, {
    method: body ? 'POST' : 'GET', headers: { Authentication: `skypetoken=${token.skypeToken}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined, redirect: 'error', signal: AbortSignal.timeout(20000),
  });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return { data: await r.json(), date: r.headers.get('date') };
};
const accountCheck = await request('users/ME/properties');
if (accountCheck.data.skypeName !== identity.skypeName) throw new Error('Account mismatch');
const page = await request('users/ME/conversations?view=mychats&pageSize=100');
const groups = page.data.conversations.filter(c => c.threadProperties?.topic === config.groupTopic);
const dms = page.data.conversations.filter(c => c.id.endsWith('@unq.gbl.spaces') && c.id.includes(self[0].mri.slice(8)) && c.id.includes(sender[0].mri.slice(8)));
if (groups.length !== 1 || dms.length !== 1) throw new Error('Test chats not unique');
const chats = [{ kind: 'dm', id: dms[0].id }, { kind: 'group', id: groups[0].id }];
for (const chat of chats) {
  const { data } = await request(`threads/${encodeURIComponent(chat.id)}/members`);
  if (!data.members?.some(m => m.id === self[0].mri) || !data.members.some(m => m.id === sender[0].mri) || (chat.kind === 'dm' && data.members.length !== 2)) throw new Error('Test membership mismatch');
}
const cutoff = Date.parse(accountCheck.date);
if (!Number.isFinite(cutoff)) throw new Error('No reliable service clock');
const marker = `${state}/relay-attempt.local.json`;
const progress = { status: 'listening', cutoff, chats: Object.fromEntries(chats.map(c => [c.kind, { status: 'waiting', id: c.id }])) };
await fs.writeFile(marker, JSON.stringify(progress), { mode: 0o600, flag: 'wx' });
console.log(JSON.stringify({ status: 'listening', kinds: ['dm', 'group'], groupPrefix: config.triggerPrefix, durationSeconds: 600 }));
const end = Date.now() + 600000;
try {
  while (Date.now() < end && chats.some(c => progress.chats[c.kind].status === 'waiting')) {
    for (const chat of chats) {
      const turn = progress.chats[chat.kind];
      if (turn.status !== 'waiting') continue;
      let link = `users/ME/conversations/${encodeURIComponent(chat.id)}/messages?pageSize=50`;
      const records = [];
      const links = new Set();
      for (let pageNumber = 0; pageNumber < 10; pageNumber++) {
        if (links.has(link)) throw new Error('Paging cycle');
        links.add(link);
        const { data } = await request(link);
        if (!Array.isArray(data.messages)) throw new Error('Malformed page');
        let reachedBoundary = false;
        for (const raw of data.messages) {
          if (typeof raw.id !== 'string' || !raw.id || typeof raw.messagetype !== 'string' || !Number.isFinite(Date.parse(raw.originalarrivaltime))) throw new Error('Malformed message');
          const timestamp = Date.parse(raw.originalarrivaltime);
          if (timestamp < cutoff) { reachedBoundary = true; continue; }
          if (raw.messagetype.startsWith('ThreadActivity/') || raw.messagetype === 'MessageDelete') continue;
          if (!['Text', 'RichText/Html'].includes(raw.messagetype)) throw new Error('Unsupported event needs inspection');
          if (typeof raw.from !== 'string' || typeof raw.content !== 'string') throw new Error('Malformed text message');
          const message = { senderMri:raw.from, content:raw.content, editTime:raw.properties?.edittime, isDeleted:Boolean(raw.properties?.deletetime) };
          const from = message.senderMri.slice(message.senderMri.lastIndexOf('/') + 1);
          if (from !== sender[0].mri || message.editTime || message.isDeleted) continue;
          const text = decodeHTML(message.content.replace(/<(br|\/p|\/div)\b[^>]*>/gi, '\n').replace(/<[^>]*>/g, '')).trim();
          if (chat.kind === 'group' && !text.startsWith(config.triggerPrefix)) continue;
          const prompt = chat.kind === 'group' ? text.slice(config.triggerPrefix.length).trim() : text;
          if (prompt) records.push({ id: raw.id, timestamp, prompt });
        }
        if (reachedBoundary || !data._metadata?.backwardLink) break;
        if (pageNumber === 9) throw new Error('History gap');
        link = data._metadata.backwardLink;
      }
      records.sort((a, b) => a.timestamp - b.timestamp || a.id.localeCompare(b.id));
      const message = records[0];
      if (!message) continue;
      turn.status = 'invoking'; turn.messageId = message.id;
      await save('relay-attempt.local.json', progress);
      const session = createHash('sha256').update(`transport-probe:${identity.skypeName}:${chat.id}`).digest('hex');
      const response = await fetch(openclaw.url, {
        method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${openclaw.token}` }, redirect: 'error', signal: AbortSignal.timeout(90000),
        body: JSON.stringify({ model: `openclaw/${openclaw.agent}`, user: `teams-${session}`, stream: false, messages: [{ role: 'user', content: JSON.stringify({ sender: sender[0].mri, chatType: chat.kind, text: message.prompt }) }] }),
      });
      if (!response.ok) throw new Error(`OpenClaw HTTP ${response.status}`);
      const output = (await response.json()).choices?.[0]?.message?.content;
      if (typeof output !== 'string' || !output.trim() || [...output].length > 3000) throw new Error('Reply outside bounded probe limit');
      turn.status = 'response_ready'; turn.response = output;
      await save('relay-attempt.local.json', progress);
      turn.status = 'sending'; turn.clientmessageid = String(Date.now());
      await save('relay-attempt.local.json', progress);
      const result = await request(`users/ME/conversations/${encodeURIComponent(chat.id)}/messages`, { content: output, messagetype: 'Text', contenttype: 'text', clientmessageid: turn.clientmessageid, imdisplayname: self[0].displayName, properties: { importance: '', subject: null } });
      if (!result.data.OriginalArrivalTime) throw new Error('Unconfirmed send');
      turn.status = 'sent'; turn.replyId = String(result.data.OriginalArrivalTime); delete turn.response;
      await save('relay-attempt.local.json', progress);
      console.log(JSON.stringify({ status: 'round-trip-confirmed', kind: chat.kind }));
    }
    if (chats.some(c => progress.chats[c.kind].status === 'waiting')) await new Promise(resolve => setTimeout(resolve, 5000));
  }
  progress.status = chats.every(c => progress.chats[c.kind].status === 'sent') ? 'passed' : 'expired-waiting';
  await save('relay-attempt.local.json', progress);
  console.log(JSON.stringify({ status: progress.status }));
} catch (e) {
  progress.status = 'stopped';
  for (const turn of Object.values(progress.chats)) if (['invoking', 'sending'].includes(turn.status)) turn.status = 'uncertain';
  await save('relay-attempt.local.json', progress);
  console.error(JSON.stringify({ status: 'stopped', category: /^HTTP \d+$/.test(e.message) ? e.message : 'contract-or-uncertain', autoRetry: false }));
  process.exitCode = 1;
}
