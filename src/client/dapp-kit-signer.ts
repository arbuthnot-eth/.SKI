/**
 * DappKitSigner — adapts wallet signPersonalMessage into Signer interface.
 * Ported from MystenLabs/sui-stack-messaging chat-app.
 */
import { Signer, parseSerializedSignature } from '@mysten/sui/cryptography';
import type { PublicKey, SignatureScheme } from '@mysten/sui/cryptography';
import { publicKeyFromSuiBytes } from '@mysten/sui/verify';
import { toBase64 } from '@mysten/sui/utils';

export type SignPersonalMessageFn = (args: {
  message: Uint8Array;
}) => Promise<{ signature: string }>;

export class DappKitSigner extends Signer {
  readonly #address: string;
  #publicKey: PublicKey | null;
  readonly #signPersonalMessage: SignPersonalMessageFn;

  constructor(opts: {
    address: string;
    publicKeyBytes?: Uint8Array;
    signPersonalMessage: SignPersonalMessageFn;
  }) {
    super();
    this.#address = opts.address;
    this.#publicKey = opts.publicKeyBytes?.length
      ? publicKeyFromSuiBytes(opts.publicKeyBytes)
      : null;
    this.#signPersonalMessage = opts.signPersonalMessage;
  }

  async sign(_bytes: Uint8Array): Promise<Uint8Array<ArrayBuffer>> {
    throw new Error('DappKitSigner.sign() not supported — use signPersonalMessage()');
  }

  override async signPersonalMessage(bytes: Uint8Array): Promise<{ bytes: string; signature: string }> {
    const { signature } = await this.#signPersonalMessage({ message: bytes });
    if (!this.#publicKey) {
      try {
        const parsed = parseSerializedSignature(signature);
        if ('publicKey' in parsed && parsed.publicKey) {
          const { publicKeyFromRawBytes } = await import('@mysten/sui/verify');
          this.#publicKey = publicKeyFromRawBytes(parsed.signatureScheme, parsed.publicKey);
        }
      } catch { /* will resolve on next call */ }
    }
    return { bytes: toBase64(bytes), signature };
  }

  getKeyScheme(): SignatureScheme {
    if (!this.#publicKey) return 'ED25519';
    const flag = this.#publicKey.flag();
    if (flag === 0x00) return 'ED25519';
    if (flag === 0x01) return 'Secp256k1';
    return 'Secp256r1';
  }

  getPublicKey(): PublicKey {
    if (!this.#publicKey) throw new Error('Public key not yet available — sign a message first');
    return this.#publicKey;
  }

  override toSuiAddress(): string {
    return this.#address;
  }
}
