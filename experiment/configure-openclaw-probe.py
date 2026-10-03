"""Create a separate loopback, tool-free Gateway; never modify the active Gateway."""
import json
import os
from pathlib import Path
import re
import secrets
import shutil
import subprocess

os.umask(0o077)
source = Path.home() / '.openclaw/openclaw.json'
original = json.loads(source.read_text())
root = Path.home() / '.openclaw-teams-probe'
root.mkdir(mode=0o700, exist_ok=True)
config = root / 'openclaw.json'
if config.exists():
    raise SystemExit('Probe configuration exists; inspect instead of overwriting')
workspace = root / 'workspace'
workspace.mkdir(mode=0o700, exist_ok=True)
agent_id = 'teams-transport-probe'
defaults = original.get('agents', {}).get('defaults', {})
data = {
    'agents': {
        'defaults': {k: defaults[k] for k in ['model', 'models', 'modelPolicy'] if k in defaults},
        'entries': {agent_id: {'workspace': str(workspace), 'skills': [], 'contextInjection': 'never', 'tools': {'deny': ['*']}}},
    },
    'models': original.get('models', {}),
    'gateway': {'mode': 'local', 'port': 18790, 'bind': 'loopback', 'auth': {'mode': 'token', 'token': secrets.token_urlsafe(48)}, 'http': {'endpoints': {'chatCompletions': {'enabled': True}}}},
}
for key in ['auth', 'secrets']:
    if key in original:
        data[key] = original[key]
# Resolve only environment variables referenced by the copied configuration.
# Read the running service environment privately; never print or log its values.
pid = subprocess.check_output(['systemctl', '--user', 'show', 'openclaw-gateway', '-p', 'MainPID', '--value'], text=True).strip()
service_env = dict(item.split('=', 1) for item in (Path('/proc') / pid / 'environ').read_bytes().decode().split('\0') if '=' in item)
names = set(re.findall(r'\$\{([A-Z_][A-Z0-9_]*)\}', json.dumps(data)))
referenced = {k: service_env[k] for k in names if k in service_env}
envfile = root / 'gateway.local.env'
# JSON double-quoted values match systemd EnvironmentFile syntax for these values.
envfile.write_text(''.join(f'{k}={json.dumps(v)}\n' for k, v in referenced.items()))
candidate = root / 'candidate.local.json'
candidate.write_text(json.dumps(data, indent=2) + '\n')
binary = shutil.which('openclaw') or str(Path.home() / '.npm-global/bin/openclaw')
env = dict(os.environ, **referenced, OPENCLAW_CONFIG_PATH=str(candidate), OPENCLAW_STATE_DIR=str(root))
result = subprocess.run([binary, 'config', 'validate', '--json'], env=env, capture_output=True, text=True)
if result.returncode:
    try:
        issues = json.loads(result.stdout).get('issues', [])
        print(json.dumps({'status': 'invalid', 'paths': [i.get('path') for i in issues]}))
    except (ValueError, TypeError):
        print('{"status":"validation-failed"}')
    raise SystemExit(1)
candidate.replace(config)
print(json.dumps({'status': 'validated', 'agent': agent_id, 'tools': 'disabled', 'bind': 'loopback', 'port': 18790}))
