import { runAction } from './action.mjs';

try {
  await runAction();
} catch (error) {
  const message = error.message.replaceAll('%', '%25').replaceAll('\r', '%0D').replaceAll('\n', '%0A');
  console.error(`::error::${message}`);
  process.exitCode = 1;
}
