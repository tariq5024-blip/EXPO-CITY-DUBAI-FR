# Device Sync Improvements Summary

## What Was Implemented

### 1. **Immediate Sync When Devices Come Online** ✅
The system already detects when devices transition from offline → online and immediately processes the sync queue for those devices:

```javascript
// In tickDeviceHealth() - processes sync queue immediately when devices come online
if (DEVICE_SYNC_QUEUE_ENABLED && devicesWentOnline.length > 0) {
  for (const d of devicesWentOnline) {
    const result = await processDeviceSyncQueueForDevice(sid, { batchSize: DEVICE_SYNC_BATCH_SIZE });
    // Processes all pending revokes/enrolls immediately
  }
}
```

### 2. **Unlimited Queue Retention** ✅
Added support for devices offline 24h, 1 week, or longer:

**New Environment Variables:**
```bash
# Enable unlimited retention (items stay pending forever until successful)
DEVICE_SYNC_UNLIMITED_RETENTION=true

# Max delay between retries (default 1 hour = 3600000ms)
DEVICE_SYNC_MAX_RETRY_DELAY_MS=3600000
```

**Behavior:**
- When `DEVICE_SYNC_UNLIMITED_RETENTION=true`:
  - Queue items are **never marked as failed**
  - They stay in "pending" status forever
  - Retry delay caps at 1 hour (configurable)
  - Items are processed immediately when device comes online

- When `false` (legacy mode):
  - Items marked as failed after `DEVICE_SYNC_MAX_RETRIES` (default 10)
  - Circuit breaker may open after consecutive failures

### 3. **Visitor Device Sync** ✅
Added full device sync support for visitors (previously only employees):

**New Functions:**
- `deriveVisitorSupremaUserId()` - Creates unique visitor IDs
- `resolveVisitorSupremaUserIdForDevice()` - Resolves stored or derived ID
- `collectVisitorRevokeUserIds()` - Collects all ID variants for deletion
- `loadVisitorPhotoFromDisk()` - Loads visitor photos from disk storage
- `removeVisitorFromDevices()` - Revokes visitor access from all readers
- `pushVisitorEnrollmentToDevices()` - Pushes visitor face enrollment to readers

**Updated Endpoints:**
- `POST /api/visitors` - Now pushes enrollment to devices when photo provided
- `DELETE /api/visitors/:id` - Revokes from devices before deleting
- `POST /api/visitors/:id/suspend` - Revokes from devices when suspending
- `POST /api/visitors/:id/suspend` - Re-enrolls when restoring from suspended
- `POST /api/visitors/:id/sync-face` - Manual re-sync to all devices
- `POST /api/visitors/:id/photo` - Update photo with optional device sync

**New Environment Variables:**
```bash
# Enable visitor revoke on delete/suspend
DEVICE_REVOKE_ON_VISITOR_REMOVE=true

# Enable visitor enrollment push to devices
VISITOR_ENROLLMENT_PUSH_DEVICES=true
```

### 4. **Offline Device Handling** ✅
When devices are offline during employee/visitor changes:

1. Operations are queued in MongoDB `device_sync_queue` collection
2. Queue items include: operation type, user IDs, photo data, retry count
3. When device comes online → immediate processing
4. Periodic processing (every 30s) for any remaining items

**Queue Processing Logic:**
```javascript
// On employee delete/suspend:
- Try to revoke from all devices immediately
- For offline devices: queue "revoke" operation
- When device comes online: process immediately

// On enrollment:
- Try to push to all devices immediately  
- For offline devices: queue "enroll" operation
- When device comes online: process immediately
```

## Configuration Summary

Add to your `.env` file:

```bash
# Device Sync Queue (Existing)
DEVICE_SYNC_QUEUE_ENABLED=true
DEVICE_SYNC_QUEUE_TICK_MS=30000
DEVICE_SYNC_MAX_RETRIES=10
DEVICE_SYNC_BATCH_SIZE=20

# NEW: Unlimited Retention (for 24h/1week+ offline devices)
DEVICE_SYNC_UNLIMITED_RETENTION=true
DEVICE_SYNC_MAX_RETRY_DELAY_MS=3600000  # 1 hour

# Employee Device Sync (Existing)
DEVICE_REVOKE_ON_EMPLOYEE_REMOVE=true
ENROLLMENT_PUSH_DEVICES=true

# Visitor Device Sync (NEW)
DEVICE_REVOKE_ON_VISITOR_REMOVE=true
VISITOR_ENROLLMENT_PUSH_DEVICES=true
```

## API Endpoints

### Employee Endpoints
- `DELETE /api/employees/:id` - Delete + revoke from devices
- `PUT /api/employees/:id` - Update (revoke if suspended)
- `POST /api/employees/:id/sync-face` - Manual sync to devices

### Visitor Endpoints  
- `POST /api/visitors` - Create + enroll to devices
- `DELETE /api/visitors/:id` - Delete + revoke from devices
- `POST /api/visitors/:id/suspend` - Suspend + revoke (or restore + enroll)
- `POST /api/visitors/:id/sync-face` - Manual sync to devices
- `POST /api/visitors/:id/photo` - Update photo + sync to devices

### Device Queue Management
- `GET /api/devices/sync-queue` - View global queue stats
- `GET /api/devices/:id/sync-queue` - View device-specific queue
- `POST /api/devices/:id/sync-queue/process` - Force process queue for device

## Monitoring

Check health endpoint for sync queue status:
```bash
curl http://localhost:4000/api/health | jq '.deviceSyncQueue'
```

Expected output:
```json
{
  "enabled": true,
  "tickMs": 30000,
  "maxRetries": 10,
  "unlimitedRetention": true,     // NEW
  "maxRetryDelayMs": 3600000,     // NEW
  "batchSize": 20,
  "circuitBreakersOpen": 0
}
```

View pending queue items:
```bash
curl http://localhost:4000/api/devices/sync-queue
```

## How It Works

### When You Delete/Suspend an Employee or Visitor:

1. **Online Devices**: Revoke happens immediately
2. **Offline Devices**: 
   - Operation queued with `status: "pending"`
   - `nextAttemptAt` set to 5 seconds later
   - Device ID and user IDs stored
3. **When Device Comes Online**:
   - Health check detects status change
   - `processDeviceSyncQueueForDevice()` called immediately
   - Pending revokes processed
4. **Extended Offline** (24h, 1 week+):
   - With unlimited retention: items stay pending forever
   - Retry every 1 hour (configurable)
   - When device returns: all pending items processed

### When You Enroll/Create:

Same flow but with "enroll" operation containing photo data.

## Database Schema

**Collection: `device_sync_queue`**
```javascript
{
  _id: ObjectId,
  deviceId: 538231609,              // Suprema device ID
  employeeId: "V12345678",          // Employee/visitor ID
  operation: "revoke|enroll|update",
  payload: {
    userIds: ["12345678", "V12345678"],
    photoBase64: "...",             // For enroll operations
    name: "John Doe",
    reason: "employee_suspended"
  },
  status: "pending|completed|failed",
  attempts: 5,
  maxRetries: 10,
  createdAt: ISODate,
  nextAttemptAt: ISODate,
  lastError: null,
  processedAt: null
}
```

## Testing

1. **Create visitor with photo** - Should enroll to online devices, queue for offline
2. **Suspend employee** - Should revoke from online, queue for offline  
3. **Take device offline** - Make changes, bring device back online - verify sync
4. **Check queue** - `/api/devices/sync-queue` shows pending operations
5. **Force process** - `POST /api/devices/:id/sync-queue/process` to retry immediately
