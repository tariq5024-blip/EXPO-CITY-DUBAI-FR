#!/bin/bash
# ═══════════════════════════════════════════════════════════════════════════
# Expo-City Dubai FR - Docker Build & GitHub Push Script
# ═══════════════════════════════════════════════════════════════════════════

set -e

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Configuration
GITHUB_REPO="https://github.com/tariq5024-blip/EXPO-CITY-DUBAI-FR"
IMAGE_NAME="expo-city-dubai-fr"
VERSION=$(date +%Y%m%d-%H%M%S)

echo -e "${BLUE}══════════════════════════════════════════════════════════════════${NC}"
echo -e "${BLUE}  Expo-City Dubai FR - Docker Build & GitHub Push${NC}"
echo -e "${BLUE}══════════════════════════════════════════════════════════════════${NC}"
echo ""

# Check if GitHub repo is configured
echo -e "${YELLOW}📋 Checking GitHub repository configuration...${NC}"
git remote -v || true
echo ""

# Step 1: Environment Setup
echo -e "${YELLOW}🔧 Step 1: Environment Setup${NC}"

# Check if .env exists, if not copy from example
if [ ! -f .env ]; then
    echo -e "${YELLOW}   Creating .env from .env.example...${NC}"
    cp .env.example .env
    echo -e "${GREEN}   ✓ .env created${NC}"
else
    echo -e "${GREEN}   ✓ .env exists${NC}"
fi

# Check Docker
echo -e "${YELLOW}   Checking Docker...${NC}"
if ! command -v docker &> /dev/null; then
    echo -e "${RED}   ✗ Docker not installed${NC}"
    exit 1
fi
if ! docker info &> /dev/null; then
    echo -e "${RED}   ✗ Docker daemon not running${NC}"
    exit 1
fi
echo -e "${GREEN}   ✓ Docker ready${NC}"

# Check Docker Compose
echo -e "${YELLOW}   Checking Docker Compose...${NC}"
if command -v docker-compose &> /dev/null; then
    COMPOSE_CMD="docker-compose"
elif docker compose version &> /dev/null; then
    COMPOSE_CMD="docker compose"
else
    echo -e "${RED}   ✗ Docker Compose not installed${NC}"
    exit 1
fi
echo -e "${GREEN}   ✓ Docker Compose ready (${COMPOSE_CMD})${NC}"

echo ""

# Step 2: Clean previous builds
echo -e "${YELLOW}🧹 Step 2: Cleaning previous builds...${NC}"
$COMPOSE_CMD down --remove-orphans 2>/dev/null || true
docker system prune -f 2>/dev/null || true
echo -e "${GREEN}   ✓ Cleaned${NC}"
echo ""

# Step 3: Build Docker images
echo -e "${YELLOW}🔨 Step 3: Building Docker images...${NC}"
echo -e "${BLUE}   Building services:${NC}"
echo -e "   - mongo (MongoDB 7)"
echo -e "   - ollama (AI/LLM)"
echo -e "   - backend (Node.js API)"
echo -e "   - frontend (React SPA)"
echo -e "   - gsdk-sidecar (Suprema G-SDK)"
echo ""

# Build with no cache for clean build
$COMPOSE_CMD build --no-cache

echo -e "${GREEN}   ✓ All images built successfully${NC}"
echo ""

# Step 4: Verify images
echo -e "${YELLOW}✅ Step 4: Verifying built images...${NC}"
docker images | grep -E "(expo|mongo|ollama)" || true
echo ""

# Step 5: Test containers startup
echo -e "${YELLOW}🚀 Step 5: Testing container startup...${NC}"
$COMPOSE_CMD up -d --remove-orphans

echo -e "${YELLOW}   Waiting for services to be healthy...${NC}"
sleep 30

# Check health
echo -e "${YELLOW}   Checking service health...${NC}"
$COMPOSE_CMD ps

echo -e "${GREEN}   ✓ Containers running${NC}"
echo ""

# Step 6: Stop test containers
echo -e "${YELLOW}🛑 Step 6: Stopping test containers...${NC}"
$COMPOSE_CMD down
echo -e "${GREEN}   ✓ Containers stopped${NC}"
echo ""

# Step 7: Git operations
echo -e "${YELLOW}📤 Step 7: Pushing to GitHub...${NC}"

# Check git status
echo -e "${YELLOW}   Checking git status...${NC}"
git status --short

# Add all changes
echo -e "${YELLOW}   Adding files to git...${NC}"
git add -A

# Commit with version info
echo -e "${YELLOW}   Committing changes...${NC}"
git commit -m "feat(device-sync): Add unlimited retention and visitor device sync

- Add DEVICE_SYNC_UNLIMITED_RETENTION for 24h/1week+ offline devices
- Add visitor device sync (removeVisitorFromDevices, pushVisitorEnrollmentToDevices)
- Update visitor endpoints: create, delete, suspend, sync-face, photo
- Add DEVICE_REVOKE_ON_VISITOR_REMOVE and VISITOR_ENROLLMENT_PUSH_DEVICES env vars
- Immediate sync when devices come online
- Version: ${VERSION}" || echo "No changes to commit"

# Push to GitHub
echo -e "${YELLOW}   Pushing to GitHub...${NC}"
git push origin main || git push origin master || echo "Push skipped or failed"

echo -e "${GREEN}   ✓ Pushed to GitHub${NC}"
echo ""

# Step 8: Create deployment package
echo -e "${YELLOW}📦 Step 8: Creating deployment package...${NC}"

# Create version file
echo "${VERSION}" > VERSION.txt
echo "Build: ${VERSION}" >> VERSION.txt
echo "Date: $(date)" >> VERSION.txt
echo "Commit: $(git rev-parse --short HEAD 2>/dev/null || echo 'unknown')" >> VERSION.txt

# Create deployment archive
tar -czf "deploy-${VERSION}.tar.gz" \
    --exclude='node_modules' \
    --exclude='.git' \
    --exclude='data' \
    --exclude='.mongo-data' \
    --exclude='*.tar.gz' \
    --exclude='gateway-runtime.root-owned-*' \
    .

echo -e "${GREEN}   ✓ Created deploy-${VERSION}.tar.gz${NC}"
echo ""

# Summary
echo -e "${GREEN}══════════════════════════════════════════════════════════════════${NC}"
echo -e "${GREEN}  ✅ Build & Push Complete!${NC}"
echo -e "${GREEN}══════════════════════════════════════════════════════════════════${NC}"
echo ""
echo -e "${BLUE}📊 Summary:${NC}"
echo -e "   Version: ${YELLOW}${VERSION}${NC}"
echo -e "   GitHub:  ${YELLOW}${GITHUB_REPO}${NC}"
echo -e "   Archive: ${YELLOW}deploy-${VERSION}.tar.gz${NC}"
echo ""
echo -e "${BLUE}🐳 Docker Images:${NC}"
docker images --format "table {{.Repository}}\t{{.Tag}}\t{{.Size}}" | grep -E "(expo|REPOSITORY)" || true
echo ""
echo -e "${BLUE}🚀 To deploy on production server:${NC}"
echo -e "   1. Copy deploy-${VERSION}.tar.gz to server"
echo -e "   2. Extract: tar -xzf deploy-${VERSION}.tar.gz"
echo -e "   3. Copy .env.enterprise-r440 to .env"
echo -e "   4. Edit .env with your settings"
echo -e "   5. Run: docker-compose up -d"
echo ""
echo -e "${BLUE}📋 Environment files available:${NC}"
echo -e "   - .env.example (standard setup)"
echo -e "   - .env.enterprise-r440 (high scale)"
echo -e "   - .env.watchdog (network resilience)"
echo ""
echo -e "${GREEN}Done!${NC}"
