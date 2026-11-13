import { createCloudBaseService, loadConfig } from './cloudbase.js';
import { createMaintenanceScheduler } from './maintenance-scheduler.js';
import { createMaintenanceStorage } from './maintenance-storage.js';
import cloudbase from '@cloudbase/node-sdk';

let service;
export async function main(event = {}, context) {
  const config = loadConfig();
  service ||= createCloudBaseService(config);
  // 未启用时保留原维护路径，用于部署切换与故障回退。
  const result = config.maintenanceBucket
    ? await createMaintenanceScheduler({ store: createMaintenanceStorage(config, context),
      maintain: service.maintenance, secret: config.hmacSecret, prefix: config.maintenancePrefix,
      timerSource: cloudbase.getCloudbaseContext(context).TRIGGER_SRC === 'timer' })(event)
    : await service.maintenance();
  console.log(JSON.stringify({ message: 'swap-maintenance complete', processed: result.processed,
    skipped: result.skipped, databaseAccessed: result.databaseAccessed }));
  return result;
}
