/** 返回是否在同一个三秒窗口内完成五次点击，不创建全局事件或定时任务。 */
export function createSecretTap(now = Date.now) {
  let started = null;
  let count = 0;
  return () => {
    const at = now();
    if (started === null || at - started > 3000 || at < started) { started = at; count = 0; }
    if (++count < 5) return false;
    started = null; count = 0;
    return true;
  };
}
