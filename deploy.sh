#!/bin/bash
# Fenix AI — Cloud Run Deploy
# Kullanım: bash deploy.sh

PROJECT_ID="photoreel-491017"
REGION="europe-west1"
SERVICE="fenix-ai"
IMAGE="gcr.io/$PROJECT_ID/$SERVICE"

echo "✦ FENIX AI Deploy başlıyor..."
echo "Proje: $PROJECT_ID | Bölge: $REGION"

# Docker image oluştur ve push et
echo "📦 Docker image oluşturuluyor..."
gcloud builds submit --tag $IMAGE --project $PROJECT_ID

# Cloud Run'a deploy et
echo "🚀 Cloud Run'a deploy ediliyor..."
gcloud run deploy $SERVICE \
  --image $IMAGE \
  --region $REGION \
  --project $PROJECT_ID \
  --platform managed \
  --allow-unauthenticated \
  --port 8080 \
  --memory 512Mi \
  --min-instances 0 \
  --max-instances 3 \
  --set-env-vars "NODE_ENV=production" \
  --set-secrets "GEMINI_API_KEY=GEMINI_API_KEY:latest,ANTHROPIC_API_KEY=ANTHROPIC_API_KEY:latest"

echo "✅ Deploy tamamlandı!"
echo "URL: https://$SERVICE-$(gcloud run services describe $SERVICE --region $REGION --project $PROJECT_ID --format 'value(status.url)' 2>/dev/null || echo 'kontrol-et')"
