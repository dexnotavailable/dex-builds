// Secret hygiene for anything that leaves the machine: log lines, repo text posted to Discord,
// worktree diffs. Redaction is a safety net, not a licence to post secret files: callers also
// skip paths that look like secret stores (isSecretPath).

const PATTERNS = [
  // GitHub tokens (classic, OAuth, app, refresh, fine-grained)
  /\bgh[pousr]_[A-Za-z0-9]{30,}\b/g,
  /\bgithub_pat_[A-Za-z0-9_]{40,}\b/g,
  // Discord bot tokens: base64 user id . timestamp . hmac
  /\b[MNO][A-Za-z\d_-]{23,27}\.[A-Za-z\d_-]{6}\.[A-Za-z\d_-]{27,}\b/g,
  // Discord webhook URLs carry their own secret
  /https:\/\/(?:ptb\.|canary\.)?discord(?:app)?\.com\/api\/webhooks\/\d+\/[A-Za-z0-9_-]+/g,
  // OpenAI / Anthropic / generic sk- keys
  /\bsk-(?:ant-|proj-)?[A-Za-z0-9_-]{20,}\b/g,
  // AWS access key ids
  /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g,
  // Google API keys
  /\bAIza[0-9A-Za-z_-]{35}\b/g,
  // Slack tokens
  /\bxox[abprs]-[A-Za-z0-9-]{10,}\b/g,
  // Stripe live/test secret keys
  /\b[rs]k_(?:live|test)_[A-Za-z0-9]{16,}\b/g,
  // A long random-looking value assigned to an obviously secret name. The value must mix
  // letters and digits (checked in the replacer) so ordinary code like `token = getToken()`
  // survives in source views.
  /((?:api[_-]?key|secret|token|password|passwd|pwd|bearer|authorization)["'\s]*[:=]\s*["']?(?:Bearer\s+)?)([A-Za-z0-9_\-+/=]{20,})/gi,
  // PEM private key blocks
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
];

/** Replace anything that looks like a credential with a marker. Safe on any string. */
export function redactSecrets(text) {
  if (typeof text !== 'string' || text.length === 0) return text;
  let out = text;
  for (const re of PATTERNS) {
    re.lastIndex = 0;
    out = out.replace(re, (match, prefix, value) => {
      // The assignment pattern keeps its left-hand side so the context stays readable.
      if (typeof prefix === 'string' && typeof value === 'string') {
        if (!/[0-9]/.test(value) || !/[A-Za-z]/.test(value)) return match;
        return `${prefix}[redacted]`;
      }
      return '[redacted]';
    });
  }
  return out;
}

const SECRET_PATH = [
  /(^|[\\/])\.env(\.[^\\/]*)?$/i,
  /(^|[\\/])auth\.json$/i,
  /\.(pem|key|p12|pfx|keystore|jks)$/i,
  /(^|[\\/])id_(rsa|dsa|ecdsa|ed25519)(\.pub)?$/i,
  // "secret"/"credential" ending a word in the file name (client_secret.json, appsecrets.json,
  // secrets.yaml), not continuing into another word (secretary.ts)
  /(^|[\\/])[^\\/]*(secret|credential)s?(?![a-z])[^\\/]*$/i,
  /(^|[\\/])(access|auth|api|bot|refresh|discord|github)[-_.]?tokens?(\.[^\\/]*)?$/i,
  /(^|[\\/])\.npmrc$/i,
  /(^|[\\/])\.git-credentials$/i,
  // anything inside a folder that exists to hold secrets
  /(^|[\\/])(secrets?|credentials?|\.ssh|\.gnupg)[\\/]/i,
];

/** True when a repo path looks like it holds credentials; such files are never posted. */
export function isSecretPath(path) {
  if (typeof path !== 'string') return false;
  return SECRET_PATH.some((re) => re.test(path));
}
