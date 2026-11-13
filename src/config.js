// Vite 的运行模式决定后端来源，线上模式不接受 URL 调试参数切回模拟后端。
export const ONLINE_BACKEND = import.meta.env?.VITE_API_MODE === 'online';
export const API_BASE_URL = (import.meta.env?.VITE_API_BASE_URL || '').replace(/\/$/, '');
