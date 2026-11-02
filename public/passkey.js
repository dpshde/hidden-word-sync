// WebAuthn passkeys used only for their PRF output: no server-side verification is needed,
// because the PRF secret itself is what unlocks the key slot.
import { prfSalt, randomBytes } from "./sync.js";

export class NoPrf extends Error {
  constructor() {
    super("This passkey can't unlock a library here (no PRF support). Use your sync key instead.");
  }
}

export const passkeysAvailable = () => typeof PublicKeyCredential !== "undefined" && !!navigator.credentials;

export const cancelled = (error) => error?.name === "NotAllowedError" || error?.name === "AbortError";

// Naming the relying party (it defaults to this anyway) lets password managers link the passkey
// to this site and to the login saved moments earlier. Passkeys made without it used the same id.
const rpId = location.hostname;

/** Creates a passkey and returns its PRF output. */
export async function createPasskeyPrf(name) {
  const salt = await prfSalt();
  const cred = await navigator.credentials.create({
    publicKey: {
      rp: { id: rpId, name: "Hidden Word" },
      user: { id: randomBytes(16), name, displayName: name },
      challenge: randomBytes(32),
      pubKeyCredParams: [
        { type: "public-key", alg: -7 },
        { type: "public-key", alg: -257 },
      ],
      authenticatorSelection: { residentKey: "required", userVerification: "required" },
      extensions: { prf: { eval: { first: salt } } },
    },
  });
  const first = cred.getClientExtensionResults().prf?.results?.first;
  // Some authenticators only evaluate PRF when signing in, not when creating.
  return first ? new Uint8Array(first) : getPasskeyPrf(cred.rawId);
}

/** Signs in with a passkey (any of this site's, or `credentialId`) and returns its PRF output. */
export async function getPasskeyPrf(credentialId) {
  const salt = await prfSalt();
  const assertion = await navigator.credentials.get({
    publicKey: {
      rpId,
      challenge: randomBytes(32),
      userVerification: "required",
      allowCredentials: credentialId ? [{ type: "public-key", id: credentialId }] : [],
      extensions: { prf: { eval: { first: salt } } },
    },
  });
  const first = assertion.getClientExtensionResults().prf?.results?.first;
  if (!first) throw new NoPrf();
  return new Uint8Array(first);
}
