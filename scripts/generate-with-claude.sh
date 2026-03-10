#!/bin/zsh

BROKER_ID="$1"

if [ -z "$BROKER_ID" ]; then
  echo "Usage: ./scripts/generate-with-claude.sh DAYNA_K"
  exit 1
fi

ROOT="$HOME/remax-ai-builder"
BROKER_DIR="$ROOT/brokers/$BROKER_ID"
PROFILE="$BROKER_DIR/profile.json"
ASSETS="$BROKER_DIR/assets"
OUTPUT="$ROOT/sites/$BROKER_ID"
PROMPT_FILE="$ROOT/prompts/website_system_prompt.md"

mkdir -p "$OUTPUT"

echo "Generating site for: $BROKER_ID"
echo "Profile: $PROFILE"
echo "Assets: $ASSETS"
echo "Output: $OUTPUT"

claude-code "
Lis le fichier suivant :
$PROFILE

Utilise aussi les fichiers présents ici :
$ASSETS

Lis aussi les instructions système ici :
$PROMPT_FILE

Ta tâche :
Crée ou remplace dans le dossier suivant :
$OUTPUT

les fichiers :
- index.html
- styles.css

Le site doit être complet, moderne, premium et prêt à prévisualiser localement.
"
