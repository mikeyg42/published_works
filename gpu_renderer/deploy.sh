#!/bin/bash

# GPU Renderer Deployment Script for Google Cloud Run
# This script builds and deploys the GPU-accelerated maze renderer to Google Cloud Run with T4 GPU support

set -e

PROJECT_ID="${PROJECT_ID:-maze-solver-project}"
REGION="${REGION:-us-central1}"
SERVICE_NAME="gpu-maze-renderer"
IMAGE_TAG="gcr.io/${PROJECT_ID}/${SERVICE_NAME}:latest"

echo "🚀 Starting GPU Maze Renderer Deployment"
echo "Project ID: ${PROJECT_ID}"
echo "Region: ${REGION}"
echo "Service: ${SERVICE_NAME}"

# Step 1: Build Docker image
echo "📦 Building Docker image..."
docker build -t ${IMAGE_TAG} .

# Step 2: Push to Google Container Registry
echo "⬆️ Pushing image to GCR..."
docker push ${IMAGE_TAG}

# Step 3: Replace PROJECT_ID in cloud-run-gpu.yaml
echo "🔧 Updating deployment configuration..."
sed "s/PROJECT_ID/${PROJECT_ID}/g" cloud-run-gpu.yaml > cloud-run-gpu-ready.yaml

# Step 4: Deploy to Cloud Run with GPU support
echo "🚀 Deploying to Cloud Run..."
gcloud run services replace cloud-run-gpu-ready.yaml \
    --region=${REGION} \
    --platform=managed

# Step 5: Allow unauthenticated access (optional - remove if authentication required)
echo "🔓 Setting up access permissions..."
gcloud run services add-iam-policy-binding ${SERVICE_NAME} \
    --region=${REGION} \
    --member="allUsers" \
    --role="roles/run.invoker"

# Step 6: Get service URL
echo "✅ Deployment complete!"
SERVICE_URL=$(gcloud run services describe ${SERVICE_NAME} \
    --region=${REGION} \
    --format="value(status.url)")

echo ""
echo "🎉 GPU Maze Renderer deployed successfully!"
echo "Service URL: ${SERVICE_URL}"
echo ""
echo "Test endpoints:"
echo "Health check: ${SERVICE_URL}/health"
echo "Render API: ${SERVICE_URL}/render (POST)"
echo ""
echo "Usage:"
echo "curl -X POST ${SERVICE_URL}/render \\"
echo "  -H 'Content-Type: application/json' \\"
echo "  -d '{\"maze_data\": {...}, \"width\": 1024, \"height\": 1024, \"samples\": 256}'"

# Clean up temp file
rm -f cloud-run-gpu-ready.yaml

echo ""
echo "📋 Deployment Notes:"
echo "- Service uses NVIDIA T4 GPUs"
echo "- Vulkan backend for headless rendering"
echo "- Auto-scaling from 0 to 3 instances"
echo "- 8GB memory, 2 CPUs per instance"
echo "- 10-minute timeout for complex renders"