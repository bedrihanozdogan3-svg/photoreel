#!/bin/bash
# Gemini Bridge - Claude <-> Gemini API köprüsü
# Kullanım: ./gemini-bridge.sh "sorunuz"

# .env dosyasından key'i oku
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
if [ -f "$SCRIPT_DIR/.env" ]; then
  source "$SCRIPT_DIR/.env"
fi
GEMINI_API_KEY="${GEMINI_API_KEY:-}"
MODEL="gemini-2.5-flash"
API_URL="https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent?key=${GEMINI_API_KEY}"

if [ -z "$1" ]; then
  echo "Kullanım: ./gemini-bridge.sh \"sorunuz\""
  exit 1
fi

QUESTION="$1"

# JSON payload oluştur
PAYLOAD=$(cat <<EOF
{
  "contents": [{
    "parts": [{"text": "${QUESTION}"}]
  }],
  "generationConfig": {
    "temperature": 0.7,
    "maxOutputTokens": 8192
  }
}
EOF
)

# Gemini API'ye gönder
RESPONSE=$(curl -s -X POST "$API_URL" \
  -H "Content-Type: application/json" \
  -d "$PAYLOAD")

# Cevabı çıkar
echo "$RESPONSE" | python3 -c "
import sys, json
try:
    data = json.load(sys.stdin)
    text = data['candidates'][0]['content']['parts'][0]['text']
    print(text)
except Exception as e:
    print(f'Hata: {e}')
    print(json.dumps(data, indent=2, ensure_ascii=False))
" 2>/dev/null || echo "$RESPONSE" | python -c "
import sys, json
try:
    data = json.load(sys.stdin)
    text = data['candidates'][0]['content']['parts'][0]['text']
    print(text)
except Exception as e:
    print(f'Hata: {e}')
    print(json.dumps(data, indent=2, ensure_ascii=False))
"
