//! Isolated real-library research with fresh synthetic accounts only.
//! Uses unchanged Olm version 1: no custom ratchet, KDF, cipher, or handshake.
//! No app transport, database, Keychain, iOS bridge, or two-phone evidence.
//! Pickles contain secrets; these tests keep them in memory and never log them.
//! Caller pin/signature fixtures below are not a production trust protocol.
//!
//! API/source checked against published vodozemac 0.11.0, upstream commit
//! db1b34820f3102307284e762f335b3f72c735bf0 (Apache-2.0):
//! https://github.com/matrix-org/vodozemac/tree/0.11.0
//! https://docs.rs/vodozemac/0.11.0/vodozemac/olm/index.html

use vodozemac::{
    Curve25519PublicKey, Ed25519PublicKey, Ed25519Signature, PickleError, base64_decode,
    base64_encode,
    olm::{
        Account, AccountPickle, DecryptionError, OlmMessage, Session, SessionConfig,
        SessionCreationError, SessionPickle,
    },
};

// Do not format provider errors or assert_eq! secret/ciphertext values on failure.
fn must<T, E>(result: Result<T, E>, check: &str) -> T {
    result.unwrap_or_else(|_| panic!("{check}"))
}

fn one_time_key(account: &mut Account) -> Curve25519PublicKey {
    account.generate_one_time_keys(1);
    *account
        .one_time_keys()
        .values()
        .next()
        .expect("synthetic one-time key exists")
}

fn snapshot(session: &Session) -> Vec<u8> {
    must(
        serde_json::to_vec(&session.pickle()),
        "serialize synthetic session",
    )
}

fn restore(bytes: &[u8]) -> Session {
    Session::from_pickle(must(
        serde_json::from_slice(bytes),
        "restore synthetic session",
    ))
}

fn wire_roundtrip(message: &OlmMessage, expected_type: usize) -> OlmMessage {
    let (kind, bytes) = message.to_parts();
    assert!(kind == expected_type, "upstream numeric wire type");
    let json = must(serde_json::to_value(message), "serialize upstream wire");
    assert!(
        json["type"].as_u64() == Some(expected_type as u64),
        "wire type is numeric"
    );
    let decoded = must(OlmMessage::from_parts(kind, &bytes), "decode upstream wire");
    assert!(
        decoded.to_parts() == (kind, bytes),
        "wire roundtrip preserves exact bytes"
    );
    let from_json: OlmMessage = must(serde_json::from_value(json), "decode upstream wire JSON");
    assert!(from_json == decoded, "upstream JSON and parts agree");
    decoded
}

fn established_pair() -> (Session, Session) {
    let alice = Account::new();
    let mut bob = Account::new();
    let bob_key = one_time_key(&mut bob);
    let mut outgoing = must(
        alice.create_outbound_session(SessionConfig::version_1(), bob.curve25519_key(), bob_key),
        "create outbound Olm session",
    );
    bob.mark_keys_as_published();
    let opening = wire_roundtrip(
        &must(outgoing.encrypt(b"synthetic opening"), "encrypt opening"),
        0,
    );
    let OlmMessage::PreKey(prekey) = opening else {
        panic!("opening must be prekey")
    };
    let incoming = must(
        bob.create_inbound_session(SessionConfig::version_1(), alice.curve25519_key(), &prekey),
        "create inbound Olm session",
    );
    assert!(
        incoming.plaintext == b"synthetic opening",
        "opening decrypts"
    );
    assert!(
        bob.stored_one_time_key_count() == 0,
        "successful inbound consumes one-time key"
    );
    let mut incoming = incoming.session;
    let reply = wire_roundtrip(
        &must(incoming.encrypt(b"synthetic reply"), "encrypt reply"),
        1,
    );
    assert!(must(outgoing.decrypt(&reply), "decrypt reply") == b"synthetic reply");
    assert!(
        outgoing.session_id() == incoming.session_id(),
        "session IDs agree"
    );
    assert!(outgoing.session_config() == SessionConfig::version_1());
    assert!(incoming.session_config() == SessionConfig::version_1());
    (outgoing, incoming)
}

#[test]
fn real_olm_roundtrip_uses_numeric_prekey_zero_and_normal_one() {
    let (mut alice, mut bob) = established_pair();
    for sequence in 0_u8..16 {
        let sent = wire_roundtrip(&must(alice.encrypt([sequence]), "encrypt forward"), 1);
        assert!(must(bob.decrypt(&sent), "decrypt forward") == [sequence]);
        let reply = wire_roundtrip(&must(bob.encrypt([sequence, 42]), "encrypt reverse"), 1);
        assert!(must(alice.decrypt(&reply), "decrypt reverse") == [sequence, 42]);
    }
    assert!(
        OlmMessage::from_parts(2, &[]).is_err(),
        "unknown wire type rejects"
    );
}

/// Test-only staging boundary. Successful decryption is the only path that
/// replaces the committed snapshot. This is NOT a durable/atomic database store.
fn receive_staged(
    committed: &mut Vec<u8>,
    message: &OlmMessage,
) -> Result<Vec<u8>, DecryptionError> {
    let mut staged = restore(committed);
    let plaintext = staged.decrypt(message)?;
    *committed = snapshot(&staged);
    Ok(plaintext)
}

#[test]
fn tamper_and_replay_reject_without_committing_staged_state() {
    let (mut alice, bob) = established_pair();
    let message = must(
        alice.encrypt(b"synthetic authenticated payload"),
        "encrypt tamper fixture",
    );
    let (kind, mut bytes) = message.to_parts();
    // Flip an existing MAC byte: retain a well-formed message, test authentication.
    *bytes.last_mut().expect("nonempty wire") ^= 1;
    let damaged = must(
        OlmMessage::from_parts(kind, &bytes),
        "tampered message still parses",
    );
    let mut committed = snapshot(&bob);
    let before = committed.clone();
    assert!(matches!(
        receive_staged(&mut committed, &damaged),
        Err(DecryptionError::InvalidMAC(_))
    ));
    assert!(
        committed == before,
        "failed authentication cannot commit staged pickle"
    );
    assert!(
        must(
            receive_staged(&mut committed, &message),
            "valid retry decrypts"
        ) == b"synthetic authenticated payload"
    );
    let after = committed.clone();
    assert!(
        after != before,
        "successful receive commits ratchet advancement"
    );
    assert!(matches!(
        receive_staged(&mut committed, &message),
        Err(DecryptionError::MissingMessageKey(_))
    ));
    assert!(committed == after, "replay cannot change committed pickle");
}

#[test]
fn three_out_of_order_messages_decrypt_once_each() {
    let (mut alice, mut bob) = established_pair();
    let messages: Vec<_> = (0_u8..3)
        .map(|n| must(alice.encrypt([n]), "encrypt out-of-order fixture"))
        .collect();
    for index in [2_usize, 0, 1] {
        assert!(must(bob.decrypt(&messages[index]), "decrypt reordered message") == [index as u8]);
        assert!(matches!(
            bob.decrypt(&messages[index]),
            Err(DecryptionError::MissingMessageKey(_))
        ));
    }
    let reply = must(
        bob.encrypt(b"synthetic after ordering"),
        "encrypt after ordering",
    );
    assert!(must(alice.decrypt(&reply), "decrypt after ordering") == b"synthetic after ordering");
    // Three messages do not establish unbounded skipped-key support.
}

#[test]
fn serialized_session_pickle_restores_and_continues_both_directions() {
    let (alice, mut bob) = established_pair();
    let bytes = snapshot(&alice);
    let mut restored = restore(&bytes);
    assert!(
        snapshot(&restored) == bytes,
        "serialized snapshot roundtrip"
    );
    let message = must(
        restored.encrypt(b"synthetic restored sender"),
        "encrypt restored sender",
    );
    assert!(must(bob.decrypt(&message), "decrypt restored sender") == b"synthetic restored sender");
    let reply = must(
        bob.encrypt(b"synthetic restored reply"),
        "encrypt restored reply",
    );
    assert!(
        must(restored.decrypt(&reply), "decrypt restored reply") == b"synthetic restored reply"
    );
}

fn corrupt_encrypted_pickle(encrypted: &str) -> String {
    let mut bytes = must(base64_decode(encrypted), "decode encrypted test pickle");
    *bytes.last_mut().expect("nonempty encrypted pickle") ^= 1;
    base64_encode(bytes)
}

// Fixed keys are ONLY synthetic fixtures, never a production key-custody design.
const PICKLE_KEY: [u8; 32] = [0x42; 32];
const WRONG_PICKLE_KEY: [u8; 32] = [0x24; 32];

#[test]
fn encrypted_session_pickle_rejects_wrong_key_and_validly_encoded_tamper() {
    let (alice, mut bob) = established_pair();
    let encrypted = alice.pickle().encrypt(&PICKLE_KEY);
    assert!(matches!(
        SessionPickle::from_encrypted(&encrypted, &WRONG_PICKLE_KEY),
        Err(PickleError::Decryption(_))
    ));
    let corrupted = corrupt_encrypted_pickle(&encrypted);
    assert!(matches!(
        SessionPickle::from_encrypted(&corrupted, &PICKLE_KEY),
        Err(PickleError::Decryption(_))
    ));
    let mut restored = Session::from_pickle(must(
        SessionPickle::from_encrypted(&encrypted, &PICKLE_KEY),
        "decrypt session pickle",
    ));
    assert!(
        snapshot(&restored) == snapshot(&alice),
        "encrypted pickle restores exact session"
    );
    let message = must(
        restored.encrypt(b"synthetic encrypted-pickle continuation"),
        "encrypt after encrypted restore",
    );
    assert!(
        must(bob.decrypt(&message), "decrypt after encrypted restore")
            == b"synthetic encrypted-pickle continuation"
    );
}

#[test]
fn encrypted_account_pickle_restores_identity_and_one_time_key_after_rejections() {
    let alice = Account::new();
    let mut bob = Account::new();
    let key = one_time_key(&mut bob);
    let encrypted = bob.pickle().encrypt(&PICKLE_KEY);
    assert!(matches!(
        AccountPickle::from_encrypted(&encrypted, &WRONG_PICKLE_KEY),
        Err(PickleError::Decryption(_))
    ));
    let corrupted = corrupt_encrypted_pickle(&encrypted);
    assert!(matches!(
        AccountPickle::from_encrypted(&corrupted, &PICKLE_KEY),
        Err(PickleError::Decryption(_))
    ));
    let mut restored = Account::from_pickle(must(
        AccountPickle::from_encrypted(&encrypted, &PICKLE_KEY),
        "decrypt account pickle",
    ));
    assert!(
        restored.identity_keys() == bob.identity_keys(),
        "account identities restored"
    );
    assert!(
        restored.one_time_keys() == bob.one_time_keys(),
        "one-time keys restored"
    );
    let mut outgoing = must(
        alice.create_outbound_session(SessionConfig::version_1(), restored.curve25519_key(), key),
        "create against restored account",
    );
    let OlmMessage::PreKey(message) = must(
        outgoing.encrypt(b"synthetic restored account"),
        "encrypt restored-account message",
    ) else {
        panic!("restored-account message must be prekey")
    };
    let incoming = must(
        restored.create_inbound_session(
            SessionConfig::version_1(),
            alice.curve25519_key(),
            &message,
        ),
        "restored account receives",
    );
    assert!(incoming.plaintext == b"synthetic restored account");
}

#[test]
fn noncontributory_identity_and_one_time_peer_keys_are_rejected() {
    let alice = Account::new();
    let mut bob = Account::new();
    let real_key = one_time_key(&mut bob);
    let zero = Curve25519PublicKey::from_bytes([0; 32]);
    assert!(matches!(
        alice.create_outbound_session(SessionConfig::version_1(), zero, real_key),
        Err(SessionCreationError::NonContributoryKey)
    ));
    assert!(matches!(
        alice.create_outbound_session(SessionConfig::version_1(), bob.curve25519_key(), zero),
        Err(SessionCreationError::NonContributoryKey)
    ));
}

#[derive(Clone, Copy, PartialEq, Eq)]
struct PeerPin {
    curve: Curve25519PublicKey,
    signing: Ed25519PublicKey,
}

fn pin(account: &Account) -> PeerPin {
    PeerPin {
        curve: account.curve25519_key(),
        signing: account.ed25519_key(),
    }
}

enum BoundaryFailure {
    IdentityChanged,
    InvalidSignature,
    InvalidPeerKey,
}

// Synthetic fixed-length signed data, NOT a production bundle protocol or a
// modification of Olm. A real system needs reviewed canonical fields, freshness,
// ownership/device binding, trusted pin provisioning and key-directory policy.
fn synthetic_signed_prekey_data(identity: PeerPin, one_time: Curve25519PublicKey) -> Vec<u8> {
    let mut bytes = b"thalassa-vodozemac-research-prekey-v1\0".to_vec();
    bytes.extend_from_slice(identity.curve.as_bytes());
    bytes.extend_from_slice(identity.signing.as_bytes());
    bytes.extend_from_slice(one_time.as_bytes());
    bytes
}

fn start_for_pinned_peer(
    sender: &Account,
    pinned: PeerPin,
    advertised: PeerPin,
    one_time: Curve25519PublicKey,
    signature: &Ed25519Signature,
) -> Result<Session, BoundaryFailure> {
    // This is caller policy. vodozemac does not discover app identity changes.
    if advertised != pinned {
        return Err(BoundaryFailure::IdentityChanged);
    }
    pinned
        .signing
        .verify(&synthetic_signed_prekey_data(pinned, one_time), signature)
        .map_err(|_| BoundaryFailure::InvalidSignature)?;
    sender
        .create_outbound_session(SessionConfig::version_1(), pinned.curve, one_time)
        .map_err(|_| BoundaryFailure::InvalidPeerKey)
}

#[test]
fn caller_pin_rejects_changed_identity_without_silently_replacing_it() {
    let alice = Account::new();
    let mut bob = Account::new();
    let bob_key = one_time_key(&mut bob);
    let pinned = pin(&bob);
    let signature = bob.sign(synthetic_signed_prekey_data(pinned, bob_key));
    assert!(start_for_pinned_peer(&alice, pinned, pinned, bob_key, &signature).is_ok());
    let mut replacement = Account::new();
    let changed_key = one_time_key(&mut replacement);
    let changed = pin(&replacement);
    let changed_signature = replacement.sign(synthetic_signed_prekey_data(changed, changed_key));
    assert!(matches!(
        start_for_pinned_peer(&alice, pinned, changed, changed_key, &changed_signature),
        Err(BoundaryFailure::IdentityChanged)
    ));
    assert!(matches!(
        start_for_pinned_peer(
            &alice,
            pinned,
            PeerPin {
                curve: changed.curve,
                ..pinned
            },
            changed_key,
            &changed_signature
        ),
        Err(BoundaryFailure::IdentityChanged)
    ));
    assert!(matches!(
        start_for_pinned_peer(
            &alice,
            pinned,
            PeerPin {
                signing: changed.signing,
                ..pinned
            },
            changed_key,
            &changed_signature
        ),
        Err(BoundaryFailure::IdentityChanged)
    ));
    assert!(pinned == pin(&bob), "accepted pin was never replaced");
}

#[test]
fn upstream_ed25519_verifies_test_prekey_and_rejects_key_or_context_substitution() {
    let alice = Account::new();
    let mut bob = Account::new();
    let bob_key = one_time_key(&mut bob);
    let pinned = pin(&bob);
    let signature = bob.sign(synthetic_signed_prekey_data(pinned, bob_key));
    assert!(start_for_pinned_peer(&alice, pinned, pinned, bob_key, &signature).is_ok());
    let mut attacker = Account::new();
    let other_key = one_time_key(&mut attacker);
    assert!(matches!(
        start_for_pinned_peer(&alice, pinned, pinned, other_key, &signature),
        Err(BoundaryFailure::InvalidSignature)
    ));
    let wrong_context = bob.sign(b"different synthetic signature context");
    assert!(matches!(
        start_for_pinned_peer(&alice, pinned, pinned, bob_key, &wrong_context),
        Err(BoundaryFailure::InvalidSignature)
    ));
    let wrong_signer = attacker.sign(synthetic_signed_prekey_data(pinned, bob_key));
    assert!(matches!(
        start_for_pinned_peer(&alice, pinned, pinned, bob_key, &wrong_signer),
        Err(BoundaryFailure::InvalidSignature)
    ));
}

#[test]
fn inbound_identity_mismatch_preserves_one_time_key_for_the_real_sender() {
    let alice = Account::new();
    let impostor = Account::new();
    let mut bob = Account::new();
    let key = one_time_key(&mut bob);
    let mut outgoing = must(
        alice.create_outbound_session(SessionConfig::version_1(), bob.curve25519_key(), key),
        "create inbound-mismatch fixture",
    );
    let OlmMessage::PreKey(message) = must(
        outgoing.encrypt(b"synthetic sender identity"),
        "encrypt inbound-mismatch fixture",
    ) else {
        panic!("identity fixture must be prekey")
    };
    assert!(matches!(
        bob.create_inbound_session(
            SessionConfig::version_1(),
            impostor.curve25519_key(),
            &message
        ),
        Err(SessionCreationError::MismatchedIdentityKey(_, _))
    ));
    assert!(
        bob.stored_one_time_key_count() == 1,
        "identity mismatch must not consume one-time key"
    );
    let incoming = must(
        bob.create_inbound_session(SessionConfig::version_1(), alice.curve25519_key(), &message),
        "accept actual sender identity",
    );
    assert!(incoming.plaintext == b"synthetic sender identity");
}

#[test]
fn correctly_addressed_tampered_prekey_preserves_account_and_one_time_key() {
    let alice = Account::new();
    let mut bob = Account::new();
    let key = one_time_key(&mut bob);
    let mut outgoing = must(
        alice.create_outbound_session(SessionConfig::version_1(), bob.curve25519_key(), key),
        "create initial authentication fixture",
    );
    let original = must(
        outgoing.encrypt(b"synthetic valid initial message"),
        "encrypt initial authentication fixture",
    );
    let (kind, mut bytes) = original.to_parts();
    assert!(kind == 0, "initial message uses prekey wire type");
    // The identity/address/key remain correct. Change only the embedded MAC.
    *bytes.last_mut().expect("nonempty prekey wire") ^= 1;
    let OlmMessage::PreKey(damaged) = must(
        OlmMessage::from_parts(kind, &bytes),
        "damaged prekey still parses",
    ) else {
        panic!("damaged initial message must remain prekey")
    };
    let before = must(
        serde_json::to_value(bob.pickle()),
        "snapshot synthetic account before failed authentication",
    );
    assert!(matches!(
        bob.create_inbound_session(SessionConfig::version_1(), alice.curve25519_key(), &damaged),
        Err(SessionCreationError::Decryption(
            DecryptionError::InvalidMAC(_)
        ))
    ));
    assert!(
        bob.stored_one_time_key_count() == 1,
        "failed authentication must not consume one-time key"
    );
    let after = must(
        serde_json::to_value(bob.pickle()),
        "snapshot synthetic account after failed authentication",
    );
    assert!(
        before == after,
        "failed initial authentication preserves full account state"
    );
    let OlmMessage::PreKey(original) = original else {
        panic!("original must be prekey")
    };
    let incoming = must(
        bob.create_inbound_session(
            SessionConfig::version_1(),
            alice.curve25519_key(),
            &original,
        ),
        "original initial message succeeds after tampered attempt",
    );
    assert!(incoming.plaintext == b"synthetic valid initial message");
    assert!(
        bob.stored_one_time_key_count() == 0,
        "successful initial authentication consumes one-time key"
    );
}

/// Test-only Rust -> actual TypeScript envelope -> Rust bridge. This mapping is
/// not an app transport/provider adapter. Missing runner configuration is fatal.
fn through_typescript_envelope(message: &OlmMessage) -> OlmMessage {
    use std::{
        io::Write,
        path::Path,
        process::{Command, Stdio},
    };

    let node = must(
        std::env::var("THALASSA_VODO_PROBE_NODE"),
        "runner must provide THALASSA_VODO_PROBE_NODE",
    );
    let bridge = Path::new(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .expect("probe has experiment parent directory")
        .join("vodozemac-wire-bridge.mjs");
    let wire = must(
        serde_json::to_string(message),
        "serialize real provider message for bridge",
    );
    let mut child = must(
        Command::new(node)
            .arg(bridge)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn(),
        "start required TypeScript envelope bridge",
    );
    {
        let mut stdin = child.stdin.take().expect("bridge stdin is captured");
        must(
            stdin.write_all(wire.as_bytes()),
            "write synthetic provider wire to bridge",
        );
    }
    let result = must(
        child.wait_with_output(),
        "wait for TypeScript envelope bridge",
    );
    // Neither stdout nor stderr is included in assertions: no ciphertext logs.
    assert!(
        result.status.success(),
        "TypeScript envelope bridge must succeed"
    );
    let returned: OlmMessage = must(
        serde_json::from_slice(&result.stdout),
        "parse required bridge provider output",
    );
    assert!(
        returned.to_parts() == message.to_parts(),
        "TypeScript roundtrip preserves exact provider type and bytes"
    );
    returned
}

#[test]
fn real_prekey_and_normal_reply_decrypt_after_rust_typescript_wire_roundtrip() {
    let alice = Account::new();
    let mut bob = Account::new();
    let key = one_time_key(&mut bob);
    let mut outgoing = must(
        alice.create_outbound_session(SessionConfig::version_1(), bob.curve25519_key(), key),
        "create cross-language fixture",
    );
    let opening = must(
        outgoing.encrypt(b"synthetic Rust to TypeScript opening"),
        "encrypt bridge opening",
    );
    assert!(
        opening.to_parts().0 == 0,
        "bridge opening is real provider prekey"
    );
    let OlmMessage::PreKey(prekey) = through_typescript_envelope(&opening) else {
        panic!("bridge must preserve prekey type")
    };
    let incoming = must(
        bob.create_inbound_session(SessionConfig::version_1(), alice.curve25519_key(), &prekey),
        "decrypt bridged real prekey",
    );
    assert!(incoming.plaintext == b"synthetic Rust to TypeScript opening");
    let mut incoming = incoming.session;
    let reply = must(
        incoming.encrypt(b"synthetic TypeScript to Rust reply"),
        "encrypt bridge reply",
    );
    assert!(
        reply.to_parts().0 == 1,
        "bridge reply is real provider normal message"
    );
    let returned = through_typescript_envelope(&reply);
    assert!(
        must(
            outgoing.decrypt(&returned),
            "decrypt bridged real normal reply"
        ) == b"synthetic TypeScript to Rust reply"
    );
}
