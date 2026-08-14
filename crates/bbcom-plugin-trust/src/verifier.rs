use ring::signature::{ED25519, UnparsedPublicKey};

use crate::Ed25519Verifier;

#[derive(Clone, Copy, Debug, Default)]
pub struct RingEd25519Verifier;

impl Ed25519Verifier for RingEd25519Verifier {
    fn verify(&self, public_key: &[u8; 32], message: &[u8], signature: &[u8; 64]) -> bool {
        UnparsedPublicKey::new(&ED25519, public_key)
            .verify(message, signature)
            .is_ok()
    }
}
