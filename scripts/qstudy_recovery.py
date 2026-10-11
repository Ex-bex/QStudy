"""Private local recovery opener: the parent captures output without logging it."""
import argparse
import json
import sys
from pathlib import Path

parser = argparse.ArgumentParser()
parser.add_argument('--project-root', required=True)
parser.add_argument('--email', required=True)
args = parser.parse_args()
root = Path(args.project_root).resolve()
sys.path.insert(0, str(root / 'backend'))

from app.config import settings, Settings
from app.database import SessionLocal
from app.services.password_recovery import find_local_reset_link, recovery_mode

try:
    if recovery_mode() != 'local':
        raise ValueError('Local recovery is disabled')
    site_url = settings.PUBLIC_BASE_URL
    state_path = root / '.local/processes.json'
    if state_path.is_file():
        state = json.loads(state_path.read_text(encoding='utf-8-sig'))
        if Path(state['workspace']).resolve() == root and state.get('frontend'):
            candidate = state['siteUrl']
            Settings.valid_site_origin(candidate)
            site_url = candidate
    with SessionLocal() as db:
        link = find_local_reset_link(db, args.email.strip(), site_url)
    if not link:
        raise ValueError('No valid recovery link')
    # PowerShell captures this in memory, never Write-Host. Do not invoke with
    # real user email through diagnostic tools that log raw stdout.
    print(json.dumps({'url': link}))
except Exception:
    sys.exit(1)
