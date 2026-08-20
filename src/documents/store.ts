export interface StoredDocument {
  readonly ciphertextHash: string;
  readonly evidenceId: string;
  readonly mediaType: string;
  readonly sizeBytes: number;
}

export interface PutDocumentInput {
  readonly evidenceId: string;
  readonly mediaType: string;
  readonly plaintext: Uint8Array;
}

export interface ProtectedDocumentStore {
  get(evidenceId: string): Promise<Uint8Array | null>;
  put(input: PutDocumentInput): Promise<StoredDocument>;
}
