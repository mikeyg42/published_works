#!/bin/bash

set -e

PROJECT_ID="${PROJECT_ID:-resume-page-430800}"
REGION="${REGION:-us-central1}"
SERVICE_NAME="gpu-maze-renderer"

echo "🚀 Final GPU Maze Renderer Deployment"
echo "Project ID: ${PROJECT_ID}"
echo "Region: ${REGION}"
echo "Service: ${SERVICE_NAME}"

# Step 1: Build with Cloud Build
echo "📦 Building with Cloud Build (this may take 10-15 minutes)..."
gcloud builds submit --config cloudbuild-hybrid.yaml --project=${PROJECT_ID} .

# Step 2: Update deployment config
echo "🔧 Updating deployment configuration..."
sed "s/PROJECT_ID/${PROJECT_ID}/g" cloud-run-gpu.yaml > cloud-run-gpu-ready.yaml

# Step 3: Deploy to Cloud Run
echo "🚀 Deploying to Cloud Run with GPU support..."
gcloud run services replace cloud-run-gpu-ready.yaml \
    --region=${REGION} \
    --platform=managed \
    --project=${PROJECT_ID}

# Step 4: Allow public access (optional)
echo "🔓 Setting up public access..."
gcloud run services add-iam-policy-binding ${SERVICE_NAME} \
    --region=${REGION} \
    --member="allUsers" \
    --role="roles/run.invoker" \
    --project=${PROJECT_ID}

# Step 5: Get service URL
SERVICE_URL=$(gcloud run services describe ${SERVICE_NAME} \
    --region=${REGION} \
    --platform=managed \
    --project=${PROJECT_ID} \
    --format="value(status.url)")

echo ""
echo "🎉 GPU Maze Renderer deployed successfully!"
echo "Service URL: ${SERVICE_URL}"
echo ""
echo "Test the service:"
echo "curl ${SERVICE_URL}/health"
echo ""
echo "For rendering, POST to ${SERVICE_URL}/render with maze data"

# Clean up
rm -f cloud-run-gpu-ready.yaml

echo "✅ Deployment complete!"