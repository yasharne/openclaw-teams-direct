#!/usr/bin/env python3
import argparse,json,subprocess
from pathlib import Path
p=argparse.ArgumentParser()
p.add_argument('--config',default=str(Path(__file__).resolve().parents[1]/'config.local.json'))
p.add_argument('--target')
p.add_argument('--id',required=True)
p.add_argument('--check',action='store_true')
a=p.parse_args();c=json.loads(Path(a.config).read_text());target=a.target or c.get('target')
if not target:p.error('configure a target alias or pass --target')
cmd=['openclaw-teams-call','--target',target,'--id',a.id]
if a.check:cmd.append('--check')
raise SystemExit(subprocess.run(cmd).returncode)
