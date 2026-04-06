/**
 * Data Locality Module
 *
 * Device-pinned storage with remote fetch, E2E encryption, and ephemeral caching.
 */

export { pinData, unpinData, sealData, getLocalManifest, findManifestEntry, searchManifest, recordFetch } from './manifest.js';
export type { ManifestEntry, PinDataOpts, PinnedDataType, AccessPolicy, LocalityPolicy } from './manifest.js';

export { generateEphemeralKeypair, encryptForRecipient, decryptWithPrivateKey } from './crypto.js';
export type { EphemeralKeypair, EncryptedPayload } from './crypto.js';

export { EphemeralCache, accessPolicyToTtlMs } from './ephemeral-cache.js';

export { DeviceDataFetcher, DataNotFoundError, DeviceOfflineError, AccessDeniedError } from './fetch-client.js';
export type { FetchResult } from './fetch-client.js';

export { requestApproval, respondToApproval, getPendingApprovals, cancelAllPendingApprovals } from './approval.js';
export type { ApprovalRequest, ApprovalDecision } from './approval.js';

export { predictNeededData, preFetchPredicted } from './predictive-fetch.js';
