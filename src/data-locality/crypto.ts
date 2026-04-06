/**
 * Device-to-Device Encryption
 *
 * E2E encryption for device-pinned data fetch using X25519 key agreement
 * and AES-256-GCM symmetric encryption. The cloud relay never sees plaintext.
 *
 * Flow:
 * 1. Requester generates ephemeral X25519 keypair
 * 2. Requester sends public key with fetch request
 * 3. Server generates its own ephemeral keypair
 * 4. Both derive shared secret via ECDH
 * 5. Server encrypts data with AES-256-GCM using derived key
 * 6. Requester decrypts with same derived key
 */

import crypto from 'crypto';

// ============================================================================
// KEY GENERATION
// ============================================================================

export interface EphemeralKeypair {
  publicKey: string;   // base64-encoded raw public key
  privateKey: string;  // base64-encoded raw private key
}

/**
 * Generate an ephemeral X25519 keypair for a single fetch request.
 */
export function generateEphemeralKeypair(): EphemeralKeypair {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('x25519', {
    publicKeyEncoding: { type: 'spki', format: 'der' },
    privateKeyEncoding: { type: 'pkcs8', format: 'der' },
  });

  return {
    publicKey: publicKey.toString('base64'),
    privateKey: privateKey.toString('base64'),
  };
}

// ============================================================================
// ENCRYPTION
// ============================================================================

export interface EncryptedPayload {
  /** Base64 server ephemeral public key */
  serverPublicKey: string;
  /** Base64 AES-256-GCM encrypted data */
  ciphertext: string;
  /** Base64 GCM initialization vector (12 bytes) */
  iv: string;
  /** Base64 GCM auth tag (16 bytes) */
  tag: string;
}

/**
 * Encrypt data for a specific recipient using their ephemeral public key.
 * Generates a server-side ephemeral keypair, derives shared secret via ECDH,
 * then encrypts with AES-256-GCM.
 */
export function encryptForRecipient(
  data: Buffer,
  recipientPublicKeyBase64: string,
): EncryptedPayload {
  // Generate server ephemeral keypair
  const serverKeypair = crypto.generateKeyPairSync('x25519', {
    publicKeyEncoding: { type: 'spki', format: 'der' },
    privateKeyEncoding: { type: 'pkcs8', format: 'der' },
  });

  // Import recipient's public key
  const recipientPublicKey = crypto.createPublicKey({
    key: Buffer.from(recipientPublicKeyBase64, 'base64'),
    format: 'der',
    type: 'spki',
  });

  // Import server's private key
  const serverPrivateKey = crypto.createPrivateKey({
    key: serverKeypair.privateKey,
    format: 'der',
    type: 'pkcs8',
  });

  // Derive shared secret via ECDH
  const sharedSecret = crypto.diffieHellman({
    publicKey: recipientPublicKey,
    privateKey: serverPrivateKey,
  });

  // Derive AES key from shared secret using HKDF
  const aesKey = crypto.hkdfSync('sha256', sharedSecret, '', 'ohwow-device-fetch', 32);

  // Encrypt with AES-256-GCM
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', Buffer.from(aesKey), iv);
  const encrypted = Buffer.concat([cipher.update(data), cipher.final()]);
  const tag = cipher.getAuthTag();

  return {
    serverPublicKey: serverKeypair.publicKey.toString('base64'),
    ciphertext: encrypted.toString('base64'),
    iv: iv.toString('base64'),
    tag: tag.toString('base64'),
  };
}

// ============================================================================
// DECRYPTION
// ============================================================================

/**
 * Decrypt data using our ephemeral private key and the server's public key.
 */
export function decryptWithPrivateKey(
  payload: EncryptedPayload,
  ourPrivateKeyBase64: string,
): Buffer {
  // Import server's ephemeral public key
  const serverPublicKey = crypto.createPublicKey({
    key: Buffer.from(payload.serverPublicKey, 'base64'),
    format: 'der',
    type: 'spki',
  });

  // Import our private key
  const ourPrivateKey = crypto.createPrivateKey({
    key: Buffer.from(ourPrivateKeyBase64, 'base64'),
    format: 'der',
    type: 'pkcs8',
  });

  // Derive same shared secret
  const sharedSecret = crypto.diffieHellman({
    publicKey: serverPublicKey,
    privateKey: ourPrivateKey,
  });

  // Derive same AES key
  const aesKey = crypto.hkdfSync('sha256', sharedSecret, '', 'ohwow-device-fetch', 32);

  // Decrypt
  const decipher = crypto.createDecipheriv(
    'aes-256-gcm',
    Buffer.from(aesKey),
    Buffer.from(payload.iv, 'base64'),
  );
  decipher.setAuthTag(Buffer.from(payload.tag, 'base64'));

  return Buffer.concat([
    decipher.update(Buffer.from(payload.ciphertext, 'base64')),
    decipher.final(),
  ]);
}
