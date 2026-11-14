import { randomBytes, scryptSync } from 'node:crypto';
import { emitKeypressEvents } from 'node:readline';

// 密码不接受命令行参数，避免进入进程参数与 shell 历史；终端输入不回显。
async function readPassword() {
  if (!process.stdin.isTTY) {
    process.stdin.setEncoding('utf8');
    let input = '';
    for await (const chunk of process.stdin) {
      input += chunk.toString('utf8');
      if (input.length > 514) throw new Error('密码过长');
    }
    return input.replace(/\r?\n$/, '');
  }
  process.stderr.write('请输入管理密码（不回显）：');
  emitKeypressEvents(process.stdin); process.stdin.setRawMode(true); process.stdin.resume();
  return new Promise((resolve, reject) => {
    let value = '';
    const finish = () => { process.stdin.off('keypress', onKey); process.stdin.setRawMode(false); process.stdin.pause(); process.stderr.write('\n'); };
    function onKey(text, key) {
      if (key.ctrl && key.name === 'c') { finish(); reject(new Error('已取消')); }
      else if (key.name === 'return' || key.name === 'enter') { finish(); resolve(value); }
      else if (key.name === 'backspace') value = [...value].slice(0, -1).join('');
      else if (!key.ctrl && !key.meta && text && value.length < 512) value += text;
    }
    process.stdin.on('keypress', onKey);
  });
}
try {
  const password = await readPassword();
  if (password.length < 16 || password.length > 512) throw new Error('管理密码需要 16–512 个字符');
  const salt = randomBytes(16);
  console.log(`scrypt$${salt.toString('hex')}$${scryptSync(password, salt, 64).toString('hex')}`);
} catch (error) { console.error(error.message); process.exitCode = 1; }
