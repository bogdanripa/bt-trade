#!/usr/bin/env node
/**
 * End-to-end tester for the ntfy.sh OTP pipeline — no BT Trade login required.
 *
 * Waits on the same topic the real module would, using the same provider,
 * with a fake `prefix` so you can verify the full pipe:
 *   phone automation → ntfy.sh → ntfyOtpProvider → parsed OTP digits.
 *
 * Usage:
 *   node bin/ntfy-test.js <username> [prefix]
 *   node bin/ntfy-test.js MYUSER 25
 *
 *   # With a custom topic (override the default derived-from-username one):
 *   BT_NTFY_TOPIC=my-topic node bin/ntfy-test.js MYUSER 25
 *
 * While it's running, from another terminal / your phone:
 *   curl -d "Codul tau BT Trade este 25-74456" https://ntfy.sh/<topic>
 *
 * On success it prints the extracted 5-digit code and exits 0.
 */

import { ntfyOtpProvider, defaultNtfyTopic } from '../src/index.js';

const [, , username, prefix = '25'] = process.argv;
if (!username) {
  console.error('usage: node bin/ntfy-test.js <username> [prefix]');
  process.exit(1);
}

const topic = process.env.BT_NTFY_TOPIC || defaultNtfyTopic(username);
console.log('ntfy topic:  https://ntfy.sh/' + topic);
console.log('username:    ' + username);
console.log('test prefix: ' + prefix);
console.log('\nFrom another terminal (or your phone SMS-forwarder), send EITHER:');
console.log(`  # Plain text (Android forwarders, curl, Tasker):`);
console.log(`  curl -d "Codul tau BT Trade este ${prefix}-74456" https://ntfy.sh/${topic}`);
console.log(`\n  # JSON-wrapped (matches the iOS Shortcut payload):`);
console.log(`  curl -H 'Content-Type: application/json' \\`);
console.log(`       -d '{"body":"Codul tau BT Trade este ${prefix}-74456"}' \\`);
console.log(`       https://ntfy.sh/${topic}`);
console.log('\nYou can also open https://ntfy.sh/' + topic + ' in a browser to watch traffic.\n');
console.log('Waiting for a matching message (Ctrl-C to abort)…');

const provider = ntfyOtpProvider();
try {
  const code = await provider({
    username,
    prefix,
    details: 'test-harness simulating SMS delivery',
    expiresIn: 600,
  });
  console.log('\n✓ Received and extracted OTP: ' + code);
  console.log('  (expected 74456 if you used the sample curl above)');
  process.exit(0);
} catch (e) {
  console.error('\n✗ Failed:', e.message);
  process.exit(1);
}
