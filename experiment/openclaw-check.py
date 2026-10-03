"""Three synthetic turns verify loopback access and isolated conversation history."""
import json
import os
from pathlib import Path
import secrets
import urllib.error
import urllib.request

os.umask(0o077)
root = Path.home() / '.openclaw-teams-probe'
config = json.loads((root / 'openclaw.json').read_text())
marker = root / 'session-test-attempt.local.json'
with marker.open('x') as f:
    json.dump({'status': 'invoking'}, f)
nonce = secrets.token_hex(8)
word = 'violet-' + secrets.token_hex(4)
headers = {'Content-Type': 'application/json', 'Authorization': 'Bearer ' + config['gateway']['auth']['token']}

def invoke(session, message):
    payload = {'model': 'openclaw/teams-transport-probe', 'user': f'teams-probe-{nonce}-{session}', 'messages': [{'role': 'user', 'content': message}], 'stream': False}
    request = urllib.request.Request('http://127.0.0.1:18790/v1/chat/completions', method='POST', headers=headers, data=json.dumps(payload).encode())
    with urllib.request.urlopen(request, timeout=90) as response:
        result = json.load(response)
    content = result.get('choices', [{}])[0].get('message', {}).get('content')
    if not isinstance(content, str) or not content:
        raise ValueError('No response content')
    return content.strip()

try:
    a1 = invoke('dm', f'Remember this transport test word for this conversation: {word}. Reply only ACK.')
    b1 = invoke('group', 'What transport test word was supplied earlier in this conversation? If none was supplied, reply only NONE. Do not invent one.')
    a2 = invoke('dm', 'What transport test word did I ask you to remember? Reply with only that word.')
    result = {'status': 'completed', 'httpResponses': 3, 'sameConversationRecall': word in a2, 'otherConversationDidNotRecall': word not in b1, 'tools': 'disabled'}
    marker.write_text(json.dumps(result))
    print(json.dumps(result))
except urllib.error.HTTPError as e:
    result = {'status': 'stopped', 'http': e.code, 'autoRetry': False}
    marker.write_text(json.dumps(result))
    print(json.dumps(result))
    raise SystemExit(1)
except Exception:
    marker.write_text('{"status":"uncertain","autoRetry":false}')
    print('{"status":"uncertain","autoRetry":false}')
    raise SystemExit(1)
