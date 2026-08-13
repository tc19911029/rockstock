#!/bin/zsh
# Read-only reconciliation audit for repo-managed and installed RockStock jobs.

set -eu

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_PLISTS="$SCRIPT_DIR/plists"
INSTALLED_PLISTS="$HOME/Library/LaunchAgents"
UID_NUM="$(id -u)"
ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
CRON_SECRET_VALUE="$(sed -n 's/^CRON_SECRET=//p' "$ROOT/.env.local" 2>/dev/null | head -1 | tr -d '\"' | tr -d "'" | xargs)"
AUDIT_TMP="$(mktemp -d /tmp/rockstock-launchd-audit.XXXXXX)"
trap 'rm -rf "$AUDIT_TMP"' EXIT

typeset -A repo installed loaded

for file in "$REPO_PLISTS"/com.rockstock.*.plist(N); do
  repo[${file:t:r}]="$file"
done

for file in "$INSTALLED_PLISTS"/com.rockstock.*.plist(N); do
  installed[${file:t:r}]="$file"
done

while IFS=$'\t' read -r _pid _status label; do
  [[ "$label" == com.rockstock.* ]] && loaded[$label]=1
done < <(launchctl list 2>/dev/null || true)

all_labels=(${(ou)${(k)repo}[@]} ${(ou)${(k)installed}[@]})
all_labels=(${(ou)all_labels})

printf 'label\trepo\tinstalled\tloaded\tdrift\tdesktop\tnpx\tweak_secret\n'
for label in $all_labels; do
  repo_state=no
  installed_state=no
  loaded_state=no
  drift='-'
  desktop=no
  npx=no
  weak_secret=no

  [[ -n "${repo[$label]-}" ]] && repo_state=yes
  [[ -n "${installed[$label]-}" ]] && installed_state=yes
  [[ -n "${loaded[$label]-}" ]] && loaded_state=yes

  if [[ "$repo_state" == yes && "$installed_state" == yes ]]; then
    rendered="$AUDIT_TMP/$label.plist"
    cp "${repo[$label]}" "$rendered"
    if [[ -n "$CRON_SECRET_VALUE" ]]; then
      CRON_SECRET_VALUE="$CRON_SECRET_VALUE" perl -pi -e '
        s{Bearer CRON_SECRET}{"Bearer " . $ENV{CRON_SECRET_VALUE}}ge;
        s{<string>CRON_SECRET</string>}{"<string>" . $ENV{CRON_SECRET_VALUE} . "</string>"}ge;
      ' "$rendered"
    fi
    /usr/bin/python3 -c \
      'import plistlib,sys; sys.exit(0 if plistlib.load(open(sys.argv[1], "rb")) == plistlib.load(open(sys.argv[2], "rb")) else 1)' \
      "$rendered" "${installed[$label]}" || drift=changed
  elif [[ "$repo_state" == yes ]]; then
    drift=not_installed
  else
    drift=unmanaged
  fi

  inspect="${installed[$label]-${repo[$label]-}}"
  if [[ -n "$inspect" ]]; then
    raw="$(<"$inspect")"
    [[ "$raw" == *'/Desktop/'* ]] && desktop=yes
    [[ "$raw" == *'npx '* ]] && npx=yes
    [[ "$raw" == *'Bearer CRON_SECRET'* ]] && weak_secret=yes
  fi

  printf '%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\n' \
    "$label" "$repo_state" "$installed_state" "$loaded_state" "$drift" \
    "$desktop" "$npx" "$weak_secret"
done

echo
echo 'Summary'
printf '  repo-managed: %d\n' ${#repo}
printf '  installed:    %d\n' ${#installed}
printf '  loaded:       %d\n' ${#loaded}
printf '  unmanaged:    %d\n' $(for l in ${(k)installed}; do [[ -z "${repo[$l]-}" ]] && echo "$l"; done | wc -l | tr -d ' ')
printf '  not installed:%d\n' $(for l in ${(k)repo}; do [[ -z "${installed[$l]-}" ]] && echo "$l"; done | wc -l | tr -d ' ')
printf '  weekday risk: %d\n' $(/usr/bin/python3 - "$INSTALLED_PLISTS" <<'PY'
import glob
import os
import plistlib
import sys

count = 0
for file in glob.glob(os.path.join(sys.argv[1], 'com.rockstock.*.plist')):
    payload = plistlib.load(open(file, 'rb'))
    interval = payload.get('StartCalendarInterval')
    entries = interval if isinstance(interval, list) else [interval] if isinstance(interval, dict) else []
    weekdays = {entry.get('Weekday') for entry in entries if 'Weekday' in entry}
    # launchd follows cron weekday semantics: 0/7=Sunday, 1=Monday, 5=Friday.
    # A 2..6 set usually means a weekday schedule was shifted to Tue..Sat.
    if weekdays == {2, 3, 4, 5, 6}:
        count += 1
print(count)
PY
)
