import { createCloudBaseService, loadConfig } from './cloudbase.js';

let service;
export async function main() {
  service ||= createCloudBaseService(loadConfig());
  const result = await service.maintenance();
  console.log(JSON.stringify({ message: 'swap-maintenance complete', processed: result.processed }));
  return result;
}
