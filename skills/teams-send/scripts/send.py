#!/usr/bin/env python3
"""Send a skill result through the local Teams bridge without Teams credentials."""
import argparse
import json
from pathlib import Path
import subprocess
import sys

parser = argparse.ArgumentParser()
parser.add_argument('--config', default=str(Path(__file__).resolve().parents[1] / 'config.local.json'))
parser.add_argument('--target', help='override the skill configuration target alias')
parser.add_argument('--id', required=True, help='stable unique event/run ID; reuse on retries')
parser.add_argument('--text', help='message text; otherwise read stdin')
parser.add_argument('--image', action='append', default=[])
args = parser.parse_args()
config = json.loads(Path(args.config).read_text())
target = args.target or config.get('target')
if not target:
    parser.error('set target in the skill configuration or pass --target')
command = ['openclaw-teams-send', '--socket', config['socket'], '--target', target, '--id', args.id]
if args.text is not None:
    command += ['--text', args.text]
for image in args.image:
    command += ['--image', image]
try:
    result = subprocess.run(command, stdin=sys.stdin, timeout=20)
except subprocess.TimeoutExpired:
    sys.exit('Submission status unknown: retry with the same --id; do not create a new ID')
sys.exit(result.returncode)
