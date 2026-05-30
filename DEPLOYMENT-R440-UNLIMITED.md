# Dell R440 Unlimited Scale Deployment Guide

## Hardware Requirements

### Minimum R440 Configuration for 50,000+ Employees
- **CPU:** 2x Intel Xeon Silver 4214R (12c/24t each) or better
- **RAM:** 64GB DDR4 ECC (upgradeable to 128GB+)
- **Storage:** 
  - OS: 2x 480GB SATA SSD (RAID 1)
  - Database: 2x 1.92TB NVMe SSD (RAID 1) or 4x 4TB SATA SSD
- **Network:** Dual 10GbE ports

### Maximum Configuration (100K+ Employees, 1000+ Devices)
- **RAM:** 128GB+
- **Storage:** 8TB+ NVMe/SATA SSD pool
- **Database:** MongoDB replica set (3 nodes on same R440 via VMs)

---

## Quick Deploy on R440

### 1. Prepare Storage (NVMe/SATA SSD)
```bash
# Create mount point for fast storage
sudo mkdir -p /mnt/faststorage
sudo mkfs.ext4 /dev/nvme0n1  # or your SSD device
sudo mount /dev/nvme0n1 /mnt/faststorage

# Add to /etc/fstab for persistence
echo '/dev/nvme0n1 /mnt/faststorage ext4 defaults,noatime,nodiratime 0 2' | sudo tee -a /etc/fstab
```

### 2. Deploy with Enterprise Configuration
```bash
# Copy enterprise config
cp .env.enterprise-r440 .env

# Edit with your passwords
nano .env

# Deploy with enterprise resources
docker compose -f docker-compose.yml -f docker-compose.enterprise.yml up -d
```

### 3. Verify Scaling Configuration
```bash
# Check MongoDB connection pool
docker exec expo-fr-mongo mongosh --eval "db.adminCommand({ currentOp: 1, active: true })"

# Check backend connection pool
docker logs expo-fr-backend | grep -i "mongo.*connected"
```

---

## Unlimited Scale Architecture

### Database Design for Unlimited Growth

| Collection | Expected Size | Indexing Strategy |
|------------|--------------|-------------------|
| `employees` | 100K+ docs | employeeId (unique), companyId + status |
| `logs` | 100M+ docs | TTL (optional), deviceId + createdAt, compound time indexes |
| `visitors` | 500K+ docs | qrToken (unique), status + updatedAt |
| `device_sync_queue` | 10K+ docs | deviceId + status + nextAttemptAt |

### Log Retention Strategies

**Option A: Unlimited Storage (R440 with 4TB+)**
```env
LOG_RETENTION_DAYS=0
```
- Keep all logs indefinitely
- NVMe SSD handles billions of rows
- Queries use compound indexes (fast)

**Option B: Tiered Storage**
```env
LOG_RETENTION_DAYS=365  # 1 year hot storage
```
- Archive old logs to cold storage
- Use backup script for export

**Option C: Sharding (100M+ employees)**
- Shard `employees` by `companyId`
- Shard `logs` by `deviceId` or date
- Requires MongoDB replica set

---

## Performance Tuning for R440

### MongoDB WiredTiger Cache
```yaml
# In mongo-scaling.conf - adjust to your RAM
storage:
  wiredTiger:
    engineConfig:
      cacheSizeGB: 32  # 50% of 64GB system
```

### Backend Connection Pool
```env
# Connection pool already set in .env.enterprise-r440
MONGODB_URI=mongodb://...?maxPoolSize=500&minPoolSize=50
```

### Device Event Processing at Scale
```env
# For 500+ devices, increase concurrency
DEVICE_EVENT_PULL_CONCURRENCY=64
DEVICE_EVENT_PULL_MS=500
```

### Face Auto-Refresh Optimization
```env
# Process more employees per batch
FACE_AUTO_REFRESH_BATCH=10
FACE_AUTO_REFRESH_TICK_MS=180000
```

---

## Monitoring at Scale

### Key Metrics to Watch
```bash
# MongoDB memory pressure
docker exec expo-fr-mongo mongosh --eval "db.serverStatus().wiredTiger.cache"

# Connection pool utilization
docker logs expo-fr-backend | grep -c "MongoDB connected"

# Device event lag
docker logs expo-fr-backend | grep "tickDeviceEventPull" | tail -20

# Queue depth (should be near 0)
curl -s http://localhost:4000/api/gsdk/diagnostics | jq '.deviceSyncQueue'
```

### Alert Thresholds
| Metric | Warning | Critical |
|--------|---------|----------|
| MongoDB Cache Pressure | >80% | >95% |
| Backend Memory | >6GB | >7.5GB |
| Device Pull Lag | >5s | >30s |
| Queue Depth | >100 | >1000 |

---

## Scaling Beyond Single R440

### 1. MongoDB Replica Set (Read Scaling)
```yaml
# Deploy 3 MongoDB instances on same R440 (VMs or containers)
rs.initiate({
  _id: "rs0",
  members: [
    { _id: 0, host: "mongo-primary:27017" },
    { _id: 1, host: "mongo-secondary1:27017" },
    { _id: 2, host: "mongo-secondary2:27017" }
  ]
})
```

### 2. Backend Horizontal Scaling
```yaml
# docker-compose.enterprise.yml
  backend:
    deploy:
      replicas: 3  # Load balance with nginx/haproxy
    ...
```

### 3. Multi-Site (Gateway Per Location)
```
Site 1: R440 + device_gateway (local readers)
Site 2: R440 + device_gateway (local readers)
Central: MongoDB replica set + aggregation API
```

---

## Backup Strategy for Large Datasets

### Incremental Backup (Hot)
```bash
# Run every 6 hours
docker exec expo-fr-mongo mongodump --uri="mongodb://admin:PASS@localhost:27017/expo-fr?authSource=admin" --archive | gzip > /backup/expo-fr-$(date +%Y%m%d-%H%M).gz
```

### Snapshot Backup (Cold, Weekly)
```bash
# Stop writes, snapshot storage, resume
# Use LVM or ZFS snapshots for instant backup
```

---

## Security Hardening at Scale

### 1. MongoDB Authentication (Required)
```env
MONGODB_URI=mongodb://admin:STRONG_PASSWORD@mongo:27017/expo-fr?authSource=admin
```

### 2. Network Isolation
```yaml
# docker-compose.enterprise.yml
services:
  mongo:
    ports:
      - "127.0.0.1:27017:27017"  # Localhost only
```

### 3. Gateway TLS (Already configured)
```env
GSDK_USE_SSL=true
GSDK_TLS_CA=/opt/gateway-cert/ca.crt
```

---

## Verification Commands

```bash
# Test 10K concurrent connections
npm run loadtest -- --concurrency=100 --requests=10000

# Verify indexes are built
docker exec expo-fr-mongo mongosh --eval "db.getSiblingDB('expo-fr').employees.getIndexes()"

# Check employee count
curl -s http://localhost:4000/api/health | jq '.counts.employees'

# Monitor real-time device events
curl -s http://localhost:4000/api/gsdk/diagnostics | jq '.lastDeviceEventPull'
```

---

## Expected Performance on R440

| Metric | 10K Employees | 50K Employees | 100K Employees |
|--------|--------------|---------------|----------------|
| Log Ingestion | 500/sec | 300/sec | 200/sec |
| API Response | <50ms | <100ms | <200ms |
| Employee Search | <100ms | <200ms | <500ms |
| Face Enrollment | 10/min | 5/min | 3/min |
| Storage (1 year) | ~100GB | ~500GB | ~1TB |

---

**For truly unlimited scale (500K+ employees):**
1. Add second R440 as MongoDB replica
2. Shard by company/region
3. Use separate gateway hosts per site
4. Contact for distributed architecture consultation
