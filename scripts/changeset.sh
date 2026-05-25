#!/usr/bin/env bash
set -e

echo "Select bump level:"
echo "  1) patch"
echo "  2) minor"
echo "  3) major"
read -rp "> " choice

case "$choice" in
  1|patch)  BUMP="patch" ;;
  2|minor)  BUMP="minor" ;;
  3|major)  BUMP="major" ;;
  *)        echo "Invalid choice"; exit 1 ;;
esac

read -rp "Description: " DESC

if [ -z "$DESC" ]; then
  echo "Description cannot be empty"
  exit 1
fi

SLUG=$(echo "$DESC" | tr '[:upper:]' '[:lower:]' | tr -cs 'a-z0-9' '-' | sed 's/^-//;s/-$//' | cut -c1-40)
FILENAME=".changeset/${SLUG}.md"

mkdir -p .changeset
cat > "$FILENAME" <<EOF
---
bump: ${BUMP}
---

${DESC}
EOF

echo "Created ${FILENAME}"
