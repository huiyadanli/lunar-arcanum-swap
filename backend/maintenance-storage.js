import COS from 'cos-nodejs-sdk-v5';
import cloudbase from '@cloudbase/node-sdk';

export function createMaintenanceStorage(config, context) {
  // Event 函数每次从本轮上下文取临时凭据，不能缓存旧凭据，也不向响应或日志输出。
  const credentials = cloudbase.getCloudbaseContext(context);
  if (!credentials.TENCENTCLOUD_SECRETID || !credentials.TENCENTCLOUD_SECRETKEY || !credentials.TENCENTCLOUD_SESSIONTOKEN) {
    throw new Error('MAINTENANCE_STORAGE_CREDENTIALS_MISSING');
  }
  const cos = new COS({ SecretId: credentials.TENCENTCLOUD_SECRETID, SecretKey: credentials.TENCENTCLOUD_SECRETKEY,
    SecurityToken: credentials.TENCENTCLOUD_SESSIONTOKEN, Timeout: 10000 });
  const location = { Bucket: config.maintenanceBucket, Region: config.maintenanceRegion };
  const call = (method, params) => new Promise((resolve, reject) => cos[method]({ ...location, ...params },
    (error, result) => error ? reject(new Error(`MAINTENANCE_STORAGE_${error.code || 'UNAVAILABLE'}`)) : resolve(result)));
  return {
    async list(prefix) {
      const keys = [];
      let marker;
      do {
        const page = await call('getBucket', { Prefix: prefix, Marker: marker, MaxKeys: 1000 });
        keys.push(...(page.Contents || []).map(o => o.Key));
        const more = page.IsTruncated === true || page.IsTruncated === 'true';
        if (more && (!page.NextMarker || page.NextMarker === marker)) throw new Error('MAINTENANCE_STORAGE_PAGINATION');
        marker = more ? page.NextMarker : undefined;
      } while (marker);
      return keys;
    },
    put: (key, value) => call('putObject', { Key: key, Body: value, ContentType: 'application/json', ACL: 'private' }),
    async remove(keys) {
      for (let offset = 0; offset < keys.length; offset += 1000) {
        const batch = keys.slice(offset, offset + 1000);
        if (batch.some(key => !key.startsWith(config.maintenancePrefix))) throw new Error('MAINTENANCE_STORAGE_INVALID_KEY');
        const result = await call('deleteMultipleObject', { Objects: batch.map(Key => ({ Key })) });
        if (result.Error?.length) throw new Error('MAINTENANCE_STORAGE_DELETE_FAILED');
      }
    },
  };
}
