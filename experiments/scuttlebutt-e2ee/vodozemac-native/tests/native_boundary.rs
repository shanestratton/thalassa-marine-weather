//! Real-provider tests using newly generated synthetic accounts; no app secrets.
//! Deliberately avoid Debug-printing messages, keys or encrypted state on failure.
use thalassa_vodozemac_native::{
    AccountState, MAX_PICKLE_BYTES, MAX_PLAINTEXT_BYTES, MAX_PUBLIC_REQUEST_BYTES, MAX_WIRE_BYTES,
    NativeCryptoError, WireMessage, decrypt, encrypt, new_account, open_session,
    sign_public_request, start_session,
};
use vodozemac::{
    Ed25519PublicKey, Ed25519Signature,
    olm::{
        Account, AccountPickle, DecryptionError, OlmMessage, PreKeyMessage, Session, SessionConfig,
        SessionCreationError, SessionPickle,
    },
};

fn must<T>(result: Result<T, NativeCryptoError>) -> T {
    result.unwrap_or_else(|_| panic!("synthetic native-boundary operation failed"))
}

fn accounts() -> (AccountState, AccountState) {
    (
        must(new_account(vec![7; 32])),
        must(new_account(vec![9; 32])),
    )
}

fn established() -> (String, String, String) {
    let (alice, bob) = accounts();
    let session = must(start_session(
        alice.account_pickle,
        vec![7; 32],
        bob.identity_curve,
        bob.one_time_key,
    ));
    let opening = must(encrypt(
        session.session_pickle,
        vec![7; 32],
        b"opening".to_vec(),
    ));
    assert!(opening.wire.message_type == 0);
    let bob_open = must(open_session(
        bob.account_pickle,
        vec![9; 32],
        alice.identity_curve,
        opening.wire,
    ));
    assert!(bob_open.plaintext == b"opening");
    let reply = must(encrypt(
        bob_open.session_pickle,
        vec![9; 32],
        b"reply".to_vec(),
    ));
    assert!(reply.wire.message_type == 1);
    let received = must(decrypt(opening.session_pickle, vec![7; 32], reply.wire));
    assert!(received.plaintext == b"reply");
    assert!(received.session_id == reply.session_id && reply.session_id == session.session_id);
    (
        received.session_pickle,
        reply.session_pickle,
        session.session_id,
    )
}

fn restored_account(pickle: &str, key: &[u8; 32]) -> Account {
    Account::from_pickle(
        AccountPickle::from_encrypted(pickle, key)
            .unwrap_or_else(|_| panic!("restore synthetic account fixture")),
    )
}

fn restored_session(pickle: &str, key: &[u8; 32]) -> Session {
    Session::from_pickle(
        SessionPickle::from_encrypted(pickle, key)
            .unwrap_or_else(|_| panic!("restore synthetic session fixture")),
    )
}

fn corrupted_pickle(pickle: &str) -> String {
    let mut changed = pickle.as_bytes().to_vec();
    changed[8] = if changed[8] == b'A' { b'B' } else { b'A' };
    String::from_utf8(changed).expect("synthetic pickle is Base64 ASCII")
}

fn damaged_wires() -> Vec<WireMessage> {
    vec![
        WireMessage {
            message_type: 2,
            body: vec![0],
        },
        WireMessage {
            message_type: 1,
            body: Vec::new(),
        },
        WireMessage {
            message_type: 0,
            body: vec![0],
        },
        WireMessage {
            message_type: 1,
            body: vec![3],
        },
        WireMessage {
            message_type: 1,
            body: vec![0; MAX_WIRE_BYTES + 1],
        },
    ]
}

fn wire_from_provider(message: OlmMessage) -> WireMessage {
    let (message_type, body) = message.to_parts();
    WireMessage {
        message_type: message_type as u32,
        body,
    }
}

fn append_varint(bytes: &mut Vec<u8>, mut value: u64) {
    while value >= 128 {
        bytes.push((value as u8 & 0x7f) | 0x80);
        value >>= 7;
    }
    bytes.push(value as u8);
}

// Rebuild synthetic public protobuf wire, never pickle/provider internals.
// This lets tests present structurally valid but unsupported-version traffic
// without enabling the provider's experimental features or changing crypto.
fn prekey_with_inner(prekey: &PreKeyMessage, inner: &[u8]) -> WireMessage {
    let mut body = vec![3];
    for (tag, key) in [
        (0x0a, prekey.one_time_key()),
        (0x12, prekey.base_key()),
        (0x1a, prekey.identity_key()),
    ] {
        body.extend([tag, 32]);
        body.extend(key.as_bytes());
    }
    body.push(0x22);
    append_varint(&mut body, inner.len() as u64);
    body.extend(inner);
    WireMessage {
        message_type: 0,
        body,
    }
}

fn unsupported_config_wire(wire: &WireMessage) -> WireMessage {
    let decoded = OlmMessage::from_parts(wire.message_type as usize, &wire.body)
        .unwrap_or_else(|_| panic!("decode synthetic configuration fixture"));
    let (mut inner, prekey) = match decoded {
        OlmMessage::Normal(message) => (message.to_bytes(), None),
        OlmMessage::PreKey(prekey) => (prekey.message().to_bytes(), Some(prekey)),
    };
    assert!(
        inner[0] == 3,
        "fixture begins with supported truncated-MAC message"
    );
    // v4 expects 32 MAC bytes rather than v3's 8; extend by the difference.
    // This is not a valid authenticated v4 message, but its encoding is valid
    // and identifies a protocol/configuration mismatch before auth is tried.
    inner[0] = 4;
    inner.extend([0; 24]);
    match prekey {
        Some(prekey) => prekey_with_inner(&prekey, &inner),
        None => WireMessage {
            message_type: 1,
            body: inner,
        },
    }
}

#[test]
fn account_contains_one_published_private_prekey_and_public_identity() {
    let account = must(new_account(vec![7; 32]));
    assert!(account.identity_curve.len() == 43);
    assert!(account.signing_key.len() == 43);
    assert!(account.one_time_key.len() == 43);
    let pickle = AccountPickle::from_encrypted(&account.account_pickle, &[7; 32])
        .unwrap_or_else(|_| panic!("decrypt synthetic account"));
    let restored = Account::from_pickle(pickle);
    assert!(
        restored.one_time_keys().is_empty(),
        "public prekey marked published"
    );
    assert!(
        restored.stored_one_time_key_count() == 1,
        "private prekey preserved"
    );
    assert!(restored.curve25519_key().to_base64() == account.identity_curve);
    assert!(restored.ed25519_key().to_base64() == account.signing_key);
}

#[test]
fn public_request_signature_verifies_exact_bytes_with_real_provider_identity() {
    let account = must(new_account(vec![7; 32]));
    // Synthetic context plus binary request bytes: the native signer must not
    // interpret text, discard NULs, or transform the caller's canonical bytes.
    let message = b"synthetic public request context v1\0register\0wire\0\xff";
    let signed = must(sign_public_request(
        account.account_pickle.clone(),
        vec![7; 32],
        message.to_vec(),
    ));
    let restored = Account::from_pickle(
        AccountPickle::from_encrypted(&account.account_pickle, &[7; 32])
            .unwrap_or_else(|_| panic!("restore synthetic signing account")),
    );
    assert!(signed.signing_key == account.signing_key);
    assert!(signed.signing_key == restored.ed25519_key().to_base64());
    assert!(signed.signature == restored.sign(message).to_base64());
    assert!(signed.signing_key.len() == 43 && signed.signature.len() == 86);
    for encoded in [&signed.signing_key, &signed.signature] {
        assert!(
            encoded
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || byte == b'+' || byte == b'/'),
            "public signing output uses unpadded standard Base64"
        );
    }
    let key = Ed25519PublicKey::from_base64(&signed.signing_key)
        .unwrap_or_else(|_| panic!("parse synthetic signing public key"));
    let signature = Ed25519Signature::from_base64(&signed.signature)
        .unwrap_or_else(|_| panic!("parse synthetic public request signature"));
    assert!(key.to_base64() == signed.signing_key);
    assert!(signature.to_base64() == signed.signature);
    assert!(key.verify(message, &signature).is_ok());
}

#[test]
fn public_request_signature_rejects_context_payload_and_wrong_account() {
    let (account, other) = accounts();
    let message = b"synthetic public request context v1\0register\0wire";
    let signed = must(sign_public_request(
        account.account_pickle,
        vec![7; 32],
        message.to_vec(),
    ));
    let key = Ed25519PublicKey::from_base64(&account.signing_key)
        .unwrap_or_else(|_| panic!("parse synthetic pinned signing key"));
    let signature = Ed25519Signature::from_base64(&signed.signature)
        .unwrap_or_else(|_| panic!("parse synthetic public request signature"));
    assert!(key.verify(message, &signature).is_ok());
    let mut changed_context = message.to_vec();
    changed_context[0] ^= 1;
    assert!(key.verify(&changed_context, &signature).is_err());
    let mut changed_payload = message.to_vec();
    *changed_payload
        .last_mut()
        .expect("synthetic request has payload") ^= 1;
    assert!(key.verify(&changed_payload, &signature).is_err());
    assert!(
        key.verify(&message[..message.len() - 1], &signature)
            .is_err()
    );
    let other_key = Ed25519PublicKey::from_base64(&other.signing_key)
        .unwrap_or_else(|_| panic!("parse synthetic other signing key"));
    assert!(other_key.verify(message, &signature).is_err());
    let other_signed = must(sign_public_request(
        other.account_pickle,
        vec![9; 32],
        message.to_vec(),
    ));
    let other_signature = Ed25519Signature::from_base64(&other_signed.signature)
        .unwrap_or_else(|_| panic!("parse synthetic other request signature"));
    assert!(key.verify(message, &other_signature).is_err());
}

#[test]
fn repeated_public_request_signing_preserves_account_and_private_prekey() {
    let (alice, bob) = accounts();
    let original_pickle = bob.account_pickle.clone();
    let message = b"synthetic public request context v1\0register\0wire";
    let first = must(sign_public_request(
        bob.account_pickle.clone(),
        vec![9; 32],
        message.to_vec(),
    ));
    let second = must(sign_public_request(
        bob.account_pickle.clone(),
        vec![9; 32],
        message.to_vec(),
    ));
    assert!(first.signing_key == second.signing_key);
    assert!(
        first.signature == second.signature,
        "provider signing is deterministic"
    );
    let restored = Account::from_pickle(
        AccountPickle::from_encrypted(&original_pickle, &[9; 32])
            .unwrap_or_else(|_| panic!("restore synthetic account after signing")),
    );
    // The pinned provider encrypts a pickle deterministically. Compare its full
    // state before/after the same immutable signing operation used by the API.
    let before_provider_signing = restored.pickle().encrypt(&[9; 32]);
    assert!(before_provider_signing == original_pickle);
    assert!(first.signature == restored.sign(message).to_base64());
    assert!(restored.pickle().encrypt(&[9; 32]) == before_provider_signing);
    assert!(restored.curve25519_key().to_base64() == bob.identity_curve);
    assert!(restored.ed25519_key().to_base64() == bob.signing_key);
    assert!(restored.one_time_keys().is_empty());
    assert!(restored.stored_one_time_key_count() == 1);
    let session = must(start_session(
        alice.account_pickle,
        vec![7; 32],
        bob.identity_curve,
        bob.one_time_key,
    ));
    let sent = must(encrypt(
        session.session_pickle,
        vec![7; 32],
        b"opening after public request signing".to_vec(),
    ));
    let opened = must(open_session(
        original_pickle,
        vec![9; 32],
        alice.identity_curve,
        sent.wire,
    ));
    assert!(opened.plaintext == b"opening after public request signing");
}

#[test]
fn public_request_signing_accepts_exact_bounds_and_rejects_invalid_input() {
    let account = must(new_account(vec![7; 32]));
    let key = Ed25519PublicKey::from_base64(&account.signing_key)
        .unwrap_or_else(|_| panic!("parse synthetic signing key for bounds"));
    for size in [1, MAX_PUBLIC_REQUEST_BYTES] {
        let message = vec![42; size];
        let signed = must(sign_public_request(
            account.account_pickle.clone(),
            vec![7; 32],
            message.clone(),
        ));
        let signature = Ed25519Signature::from_base64(&signed.signature)
            .unwrap_or_else(|_| panic!("parse synthetic bounds signature"));
        assert!(key.verify(&message, &signature).is_ok());
    }
    for size in [0, MAX_PUBLIC_REQUEST_BYTES + 1] {
        // Invalid message bounds take precedence over provider pickle parsing.
        assert!(matches!(
            sign_public_request(
                "malformed synthetic pickle".into(),
                vec![7; 32],
                vec![42; size]
            ),
            Err(NativeCryptoError::InvalidInput)
        ));
    }
    for size in [0, 31, 33] {
        assert!(matches!(
            sign_public_request(account.account_pickle.clone(), vec![7; size], vec![42]),
            Err(NativeCryptoError::InvalidInput)
        ));
    }
    for pickle in [String::new(), "x".repeat(MAX_PICKLE_BYTES + 1)] {
        assert!(matches!(
            sign_public_request(pickle, vec![7; 32], vec![42]),
            Err(NativeCryptoError::InvalidInput)
        ));
    }
}

#[test]
fn public_request_signing_rejects_wrong_pickle_key_and_corrupted_pickle_generically() {
    let account = must(new_account(vec![7; 32]));
    assert!(matches!(
        sign_public_request(account.account_pickle.clone(), vec![8; 32], vec![42]),
        Err(NativeCryptoError::OperationFailed)
    ));
    let mut corrupted = account.account_pickle.into_bytes();
    corrupted[8] = if corrupted[8] == b'A' { b'B' } else { b'A' };
    let corrupted = String::from_utf8(corrupted).expect("synthetic pickle is Base64 ASCII");
    assert!(matches!(
        sign_public_request(corrupted, vec![7; 32], vec![42]),
        Err(NativeCryptoError::OperationFailed)
    ));
}

#[test]
fn encrypted_snapshots_restore_and_continue_both_directions() {
    let (mut alice, mut bob, session_id) = established();
    for number in 0_u8..8 {
        // Each function call decrypts a pickle afresh, equivalent to dropping all
        // live provider objects. This does not prove durable process crash safety.
        let sent = must(encrypt(alice, vec![7; 32], vec![number]));
        assert!(sent.wire.message_type == 1 && sent.session_id == session_id);
        let received = must(decrypt(bob, vec![9; 32], sent.wire));
        assert!(received.plaintext == [number] && received.session_id == session_id);
        alice = sent.session_pickle;
        let reply = must(encrypt(
            received.session_pickle,
            vec![9; 32],
            vec![number, 42],
        ));
        let received = must(decrypt(alice, vec![7; 32], reply.wire));
        assert!(received.plaintext == [number, 42]);
        alice = received.session_pickle;
        bob = reply.session_pickle;
    }
    let restored = Session::from_pickle(
        SessionPickle::from_encrypted(&alice, &[7; 32])
            .unwrap_or_else(|_| panic!("decrypt synthetic session")),
    );
    assert!(restored.session_config() == SessionConfig::version_1());
}

#[test]
fn tampering_rejects_and_retry_with_unchanged_input_succeeds_then_replay_fails() {
    let (alice, bob, _) = established();
    let sent = must(encrypt(alice, vec![7; 32], b"authenticated".to_vec()));
    let mut changed = sent.wire.clone();
    *changed.body.last_mut().expect("synthetic message has MAC") ^= 1;
    assert!(matches!(
        decrypt(bob.clone(), vec![9; 32], changed),
        Err(NativeCryptoError::MessageNotOpened)
    ));
    let received = must(decrypt(bob, vec![9; 32], sent.wire.clone()));
    assert!(received.plaintext == b"authenticated");
    assert!(matches!(
        decrypt(received.session_pickle, vec![9; 32], sent.wire),
        Err(NativeCryptoError::MessageNotOpened)
    ));
}

#[test]
fn three_out_of_order_messages_decrypt_once_each() {
    let (mut alice, mut bob, _) = established();
    let mut messages = Vec::new();
    for number in 0_u8..3 {
        let sent = must(encrypt(alice, vec![7; 32], vec![number]));
        alice = sent.session_pickle;
        messages.push(sent.wire);
    }
    for index in [2_usize, 0, 1] {
        let received = must(decrypt(bob, vec![9; 32], messages[index].clone()));
        assert!(received.plaintext == [index as u8]);
        bob = received.session_pickle;
        assert!(matches!(
            decrypt(bob.clone(), vec![9; 32], messages[index].clone()),
            Err(NativeCryptoError::MessageNotOpened)
        ));
    }
}

#[test]
fn wrong_pickle_key_and_corrupted_pickle_reject() {
    let (alice, bob, _) = established();
    assert!(matches!(
        encrypt(alice.clone(), vec![8; 32], b"no".to_vec()),
        Err(NativeCryptoError::OperationFailed)
    ));
    let sent = must(encrypt(alice.clone(), vec![7; 32], b"yes".to_vec()));
    assert!(matches!(
        decrypt(bob, vec![8; 32], sent.wire),
        Err(NativeCryptoError::OperationFailed)
    ));
    let mut corrupted = alice.into_bytes();
    corrupted[8] = if corrupted[8] == b'A' { b'B' } else { b'A' };
    let corrupted = String::from_utf8(corrupted).expect("base64 ASCII fixture");
    assert!(matches!(
        encrypt(corrupted, vec![7; 32], b"no".to_vec()),
        Err(NativeCryptoError::OperationFailed)
    ));
    let (account, peer) = accounts();
    assert!(matches!(
        start_session(
            account.account_pickle,
            vec![8; 32],
            peer.identity_curve,
            peer.one_time_key
        ),
        Err(NativeCryptoError::OperationFailed)
    ));
}

#[test]
fn pinned_sender_and_opening_tamper_fail_without_consuming_prekey() {
    let (alice, bob) = accounts();
    let other = must(new_account(vec![3; 32]));
    let session = must(start_session(
        alice.account_pickle,
        vec![7; 32],
        bob.identity_curve,
        bob.one_time_key,
    ));
    let sent = must(encrypt(
        session.session_pickle,
        vec![7; 32],
        b"opening".to_vec(),
    ));
    assert!(matches!(
        open_session(
            bob.account_pickle.clone(),
            vec![9; 32],
            other.identity_curve,
            sent.wire.clone()
        ),
        Err(NativeCryptoError::MessageNotOpened)
    ));
    let mut tampered = sent.wire.clone();
    *tampered.body.last_mut().expect("synthetic opening has MAC") ^= 1;
    assert!(matches!(
        open_session(
            bob.account_pickle.clone(),
            vec![9; 32],
            alice.identity_curve.clone(),
            tampered
        ),
        Err(NativeCryptoError::MessageNotOpened)
    ));
    let opened = must(open_session(
        bob.account_pickle,
        vec![9; 32],
        alice.identity_curve.clone(),
        sent.wire.clone(),
    ));
    assert!(opened.plaintext == b"opening");
    // New account snapshot consumed the single prekey. Reusing it is rejected.
    assert!(matches!(
        open_session(
            opened.account_pickle,
            vec![9; 32],
            alice.identity_curve,
            sent.wire
        ),
        Err(NativeCryptoError::MessageNotOpened)
    ));
}

#[test]
fn existing_session_checks_prekey_outer_header_before_inner_decryption() {
    let (alice, bob) = accounts();
    let session = must(start_session(
        alice.account_pickle,
        vec![7; 32],
        bob.identity_curve,
        bob.one_time_key,
    ));
    let first = must(encrypt(
        session.session_pickle,
        vec![7; 32],
        b"first".to_vec(),
    ));
    let opened = must(open_session(
        bob.account_pickle,
        vec![9; 32],
        alice.identity_curve,
        first.wire,
    ));
    // Without an inbound reply the initiator still sends prekey envelopes.
    let second = must(encrypt(
        first.session_pickle,
        vec![7; 32],
        b"second".to_vec(),
    ));
    assert!(second.wire.message_type == 0);
    let mut altered = second.wire.clone();
    assert!(
        altered.body[1] == 0x0a && altered.body[2] == 32,
        "upstream OTK protobuf prefix"
    );
    altered.body[3] ^= 1;
    let decoded = OlmMessage::from_parts(0, &altered.body)
        .unwrap_or_else(|_| panic!("altered prekey remains structurally valid"));
    let pickle = SessionPickle::from_encrypted(&opened.session_pickle, &[9; 32])
        .unwrap_or_else(|_| panic!("restore synthetic session"));
    let mut raw = Session::from_pickle(pickle);
    assert!(
        raw.decrypt(&decoded).is_ok(),
        "upstream alone ignores existing-session outer keys"
    );
    assert!(matches!(
        decrypt(opened.session_pickle.clone(), vec![9; 32], altered),
        Err(NativeCryptoError::MessageNotOpened)
    ));
    assert!(must(decrypt(opened.session_pickle, vec![9; 32], second.wire)).plaintext == b"second");
}

#[test]
fn malformed_wire_is_message_failure_but_local_bounds_remain_input_failure() {
    for size in [0, 31, 33] {
        assert!(matches!(
            new_account(vec![1; size]),
            Err(NativeCryptoError::InvalidInput)
        ));
    }
    let (alice, bob, _) = established();
    for wire in [
        WireMessage {
            message_type: 2,
            body: vec![0],
        },
        WireMessage {
            message_type: u32::MAX,
            body: vec![0],
        },
        WireMessage {
            message_type: 1,
            body: Vec::new(),
        },
        WireMessage {
            message_type: 1,
            body: vec![0; MAX_WIRE_BYTES + 1],
        },
    ] {
        assert!(matches!(
            decrypt(bob.clone(), vec![9; 32], wire),
            Err(NativeCryptoError::MessageNotOpened)
        ));
    }
    assert!(matches!(
        encrypt(alice.clone(), vec![7; 32], vec![0; MAX_PLAINTEXT_BYTES + 1]),
        Err(NativeCryptoError::InvalidInput)
    ));
    assert!(matches!(
        encrypt("x".repeat(MAX_PICKLE_BYTES + 1), vec![7; 32], vec![0]),
        Err(NativeCryptoError::InvalidInput)
    ));
    assert!(matches!(
        encrypt(String::new(), vec![7; 32], vec![0]),
        Err(NativeCryptoError::InvalidInput)
    ));
    let (account, peer) = accounts();
    assert!(matches!(
        start_session(
            account.account_pickle,
            vec![7; 32],
            format!("{}=", peer.identity_curve),
            peer.one_time_key
        ),
        Err(NativeCryptoError::InvalidInput)
    ));
    let normal = must(encrypt(alice, vec![7; 32], vec![1]));
    let (account, _) = accounts();
    assert!(matches!(
        open_session(
            account.account_pickle,
            vec![7; 32],
            account.identity_curve,
            normal.wire
        ),
        Err(NativeCryptoError::MessageNotOpened)
    ));
}

#[test]
fn damaged_wire_never_masks_local_restore_failure_and_valid_retry_uses_exact_snapshot() {
    let (alice_session, bob_session, _) = established();
    let (alice, bob) = accounts();
    let bad_session = corrupted_pickle(&bob_session);
    let bad_account = corrupted_pickle(&bob.account_pickle);
    for wire in damaged_wires() {
        assert!(matches!(
            decrypt(bad_session.clone(), vec![9; 32], wire.clone()),
            Err(NativeCryptoError::OperationFailed)
        ));
        assert!(matches!(
            decrypt(bob_session.clone(), vec![8; 32], wire.clone()),
            Err(NativeCryptoError::OperationFailed)
        ));
        assert!(matches!(
            open_session(
                bad_account.clone(),
                vec![9; 32],
                alice.identity_curve.clone(),
                wire.clone()
            ),
            Err(NativeCryptoError::OperationFailed)
        ));
        assert!(matches!(
            open_session(
                bob.account_pickle.clone(),
                vec![8; 32],
                alice.identity_curve.clone(),
                wire.clone()
            ),
            Err(NativeCryptoError::OperationFailed)
        ));
        assert!(matches!(
            decrypt(bob_session.clone(), vec![9; 32], wire.clone()),
            Err(NativeCryptoError::MessageNotOpened)
        ));
        assert!(matches!(
            open_session(
                bob.account_pickle.clone(),
                vec![9; 32],
                alice.identity_curve.clone(),
                wire.clone()
            ),
            Err(NativeCryptoError::MessageNotOpened)
        ));
        for bad_pickle in [String::new(), "x".repeat(MAX_PICKLE_BYTES + 1)] {
            assert!(matches!(
                decrypt(bad_pickle.clone(), vec![9; 32], wire.clone()),
                Err(NativeCryptoError::InvalidInput)
            ));
            assert!(matches!(
                open_session(
                    bad_pickle,
                    vec![9; 32],
                    alice.identity_curve.clone(),
                    wire.clone()
                ),
                Err(NativeCryptoError::InvalidInput)
            ));
        }
        assert!(matches!(
            decrypt(bob_session.clone(), vec![9; 31], wire.clone()),
            Err(NativeCryptoError::InvalidInput)
        ));
        assert!(matches!(
            open_session(
                bob.account_pickle.clone(),
                vec![9; 31],
                alice.identity_curve.clone(),
                wire.clone()
            ),
            Err(NativeCryptoError::InvalidInput)
        ));
        assert!(matches!(
            open_session(
                bob.account_pickle.clone(),
                vec![9; 32],
                "invalid pinned key".into(),
                wire
            ),
            Err(NativeCryptoError::InvalidInput)
        ));
    }
    // Error returns contain neither an advanced pickle nor any plaintext.
    // Original full pickle bytes still restore identically, and valid traffic
    // succeeds using those same inputs after every attempted damaged message.
    assert!(
        restored_session(&bob_session, &[9; 32])
            .pickle()
            .encrypt(&[9; 32])
            == bob_session
    );
    assert!(
        restored_account(&bob.account_pickle, &[9; 32])
            .pickle()
            .encrypt(&[9; 32])
            == bob.account_pickle
    );
    let sent = must(encrypt(
        alice_session,
        vec![7; 32],
        b"after damaged normal messages".to_vec(),
    ));
    assert!(
        must(decrypt(bob_session, vec![9; 32], sent.wire)).plaintext
            == b"after damaged normal messages"
    );
    let session = must(start_session(
        alice.account_pickle,
        vec![7; 32],
        bob.identity_curve,
        bob.one_time_key,
    ));
    let sent = must(encrypt(
        session.session_pickle,
        vec![7; 32],
        b"after damaged opening messages".to_vec(),
    ));
    let opened = must(open_session(
        bob.account_pickle,
        vec![9; 32],
        alice.identity_curve,
        sent.wire,
    ));
    assert!(opened.plaintext == b"after damaged opening messages");
}

#[test]
fn unsupported_protocol_configuration_is_never_a_deferable_message_error() {
    let (alice, bob) = accounts();
    let session = must(start_session(
        alice.account_pickle,
        vec![7; 32],
        bob.identity_curve,
        bob.one_time_key,
    ));
    let first = must(encrypt(
        session.session_pickle,
        vec![7; 32],
        b"first".to_vec(),
    ));
    let unsupported = unsupported_config_wire(&first.wire);
    let OlmMessage::PreKey(decoded) = OlmMessage::from_parts(0, &unsupported.body)
        .unwrap_or_else(|_| panic!("unsupported opening configuration is structurally valid"))
    else {
        panic!("synthetic configuration fixture is a prekey message");
    };
    let mut raw_account = restored_account(&bob.account_pickle, &[9; 32]);
    assert!(matches!(
        raw_account.create_inbound_session(
            SessionConfig::version_1(),
            decoded.identity_key(),
            &decoded
        ),
        Err(SessionCreationError::MismatchedSessionConfig { .. })
    ));
    assert!(matches!(
        open_session(
            bob.account_pickle.clone(),
            vec![9; 32],
            alice.identity_curve.clone(),
            unsupported
        ),
        Err(NativeCryptoError::OperationFailed)
    ));
    assert!(raw_account.pickle().encrypt(&[9; 32]) == bob.account_pickle);
    let opened = must(open_session(
        bob.account_pickle,
        vec![9; 32],
        alice.identity_curve,
        first.wire,
    ));
    let second = must(encrypt(
        first.session_pickle,
        vec![7; 32],
        b"second".to_vec(),
    ));
    assert!(matches!(
        decrypt(
            opened.session_pickle.clone(),
            vec![9; 32],
            unsupported_config_wire(&second.wire)
        ),
        Err(NativeCryptoError::OperationFailed)
    ));
    assert!(must(decrypt(opened.session_pickle, vec![9; 32], second.wire)).plaintext == b"second");

    let (alice_session, bob_session, _) = established();
    let normal = must(encrypt(
        alice_session,
        vec![7; 32],
        b"normal configuration".to_vec(),
    ));
    assert!(normal.wire.message_type == 1);
    let unsupported = unsupported_config_wire(&normal.wire);
    let decoded = OlmMessage::from_parts(1, &unsupported.body)
        .unwrap_or_else(|_| panic!("unsupported normal configuration is structurally valid"));
    let mut raw = restored_session(&bob_session, &[9; 32]);
    assert!(matches!(
        raw.decrypt(&decoded),
        Err(DecryptionError::InvalidMACLength(_, _))
    ));
    assert!(matches!(
        decrypt(bob_session.clone(), vec![9; 32], unsupported),
        Err(NativeCryptoError::OperationFailed)
    ));
    assert!(raw.pickle().encrypt(&[9; 32]) == bob_session);
    assert!(
        must(decrypt(bob_session, vec![9; 32], normal.wire)).plaintext == b"normal configuration"
    );
}

#[test]
fn incoming_noncontributory_key_is_typed_and_does_not_consume_prekey() {
    let (alice, bob) = accounts();
    let session = must(start_session(
        alice.account_pickle,
        vec![7; 32],
        bob.identity_curve,
        bob.one_time_key,
    ));
    let sent = must(encrypt(
        session.session_pickle,
        vec![7; 32],
        b"contributory retry".to_vec(),
    ));
    let mut damaged = sent.wire.clone();
    assert!(
        damaged.body[35] == 0x12 && damaged.body[36] == 32,
        "synthetic base-key protobuf prefix"
    );
    damaged.body[37..69].fill(0);
    let OlmMessage::PreKey(decoded) = OlmMessage::from_parts(0, &damaged.body)
        .unwrap_or_else(|_| panic!("zero synthetic base key remains structurally valid"))
    else {
        panic!("synthetic noncontributory fixture is a prekey message");
    };
    let mut raw = restored_account(&bob.account_pickle, &[9; 32]);
    assert!(matches!(
        raw.create_inbound_session(SessionConfig::version_1(), decoded.identity_key(), &decoded),
        Err(SessionCreationError::NonContributoryKey)
    ));
    assert!(matches!(
        open_session(
            bob.account_pickle.clone(),
            vec![9; 32],
            alice.identity_curve.clone(),
            damaged
        ),
        Err(NativeCryptoError::MessageNotOpened)
    ));
    assert!(raw.pickle().encrypt(&[9; 32]) == bob.account_pickle);
    assert!(
        must(open_session(
            bob.account_pickle,
            vec![9; 32],
            alice.identity_curve,
            sent.wire
        ))
        .plaintext
            == b"contributory retry"
    );
}

#[test]
fn incoming_excessive_gap_is_typed_without_advancing_saved_state() {
    let (alice, bob, _) = established();
    let sent = must(encrypt(alice, vec![7; 32], b"gap retry".to_vec()));
    let OlmMessage::Normal(message) = OlmMessage::from_parts(1, &sent.wire.body)
        .unwrap_or_else(|_| panic!("decode synthetic gap fixture"))
    else {
        panic!("synthetic gap fixture is a normal message");
    };
    let mut body = vec![3, 0x0a, 32];
    body.extend(message.ratchet_key().as_bytes());
    body.push(0x10);
    append_varint(&mut body, 1_000_000);
    body.push(0x22);
    append_varint(&mut body, message.ciphertext().len() as u64);
    body.extend(message.ciphertext());
    body.extend(&sent.wire.body[sent.wire.body.len() - 8..]);
    let decoded = OlmMessage::from_parts(1, &body)
        .unwrap_or_else(|_| panic!("excessive gap remains structurally valid"));
    let mut raw = restored_session(&bob, &[9; 32]);
    assert!(matches!(
        raw.decrypt(&decoded),
        Err(DecryptionError::TooBigMessageGap(_, _))
    ));
    assert!(matches!(
        decrypt(
            bob.clone(),
            vec![9; 32],
            WireMessage {
                message_type: 1,
                body
            }
        ),
        Err(NativeCryptoError::MessageNotOpened)
    ));
    assert!(raw.pickle().encrypt(&[9; 32]) == bob);
    assert!(must(decrypt(bob, vec![9; 32], sent.wire)).plaintext == b"gap retry");
}

#[test]
fn authenticated_oversized_plaintext_remains_output_failure_not_deferable_message() {
    let (alice, bob, _) = established();
    let mut raw_sender = restored_session(&alice, &[7; 32]);
    // A real peer can encrypt more than this boundary's accepted output size.
    // Bypass only the adapter's input cap in this synthetic fixture, not crypto.
    let large = raw_sender
        .encrypt(&vec![42; MAX_PLAINTEXT_BYTES + 1])
        .unwrap_or_else(|_| panic!("encrypt synthetic oversized incoming plaintext"));
    let large_wire = wire_from_provider(large);
    assert!(
        large_wire.body.len() <= MAX_WIRE_BYTES,
        "fixture reaches post-auth output cap"
    );
    let decoded = OlmMessage::from_parts(large_wire.message_type as usize, &large_wire.body)
        .unwrap_or_else(|_| panic!("decode synthetic oversized plaintext fixture"));
    let mut raw_receiver = restored_session(&bob, &[9; 32]);
    let plaintext = raw_receiver
        .decrypt(&decoded)
        .unwrap_or_else(|_| panic!("oversized fixture authenticates with real provider"));
    assert!(plaintext.len() == MAX_PLAINTEXT_BYTES + 1);
    assert!(matches!(
        decrypt(bob.clone(), vec![9; 32], large_wire),
        Err(NativeCryptoError::OperationFailed)
    ));
    assert!(restored_session(&bob, &[9; 32]).pickle().encrypt(&[9; 32]) == bob);
    let small = wire_from_provider(
        raw_sender
            .encrypt(b"after oversized normal message")
            .unwrap_or_else(|_| panic!("encrypt synthetic retry after output cap")),
    );
    assert!(must(decrypt(bob, vec![9; 32], small)).plaintext == b"after oversized normal message");

    let (alice, bob) = accounts();
    let session = must(start_session(
        alice.account_pickle,
        vec![7; 32],
        bob.identity_curve,
        bob.one_time_key,
    ));
    let mut raw_sender = restored_session(&session.session_pickle, &[7; 32]);
    let large = wire_from_provider(
        raw_sender
            .encrypt(&vec![42; MAX_PLAINTEXT_BYTES + 1])
            .unwrap_or_else(|_| panic!("encrypt synthetic oversized opening plaintext")),
    );
    assert!(large.message_type == 0 && large.body.len() <= MAX_WIRE_BYTES);
    assert!(matches!(
        open_session(
            bob.account_pickle.clone(),
            vec![9; 32],
            alice.identity_curve.clone(),
            large
        ),
        Err(NativeCryptoError::OperationFailed)
    ));
    let original = restored_account(&bob.account_pickle, &[9; 32]);
    assert!(original.pickle().encrypt(&[9; 32]) == bob.account_pickle);
    assert!(original.stored_one_time_key_count() == 1);
    let small = wire_from_provider(
        raw_sender
            .encrypt(b"after oversized opening message")
            .unwrap_or_else(|_| panic!("encrypt synthetic opening retry after output cap")),
    );
    assert!(
        must(open_session(
            bob.account_pickle,
            vec![9; 32],
            alice.identity_curve,
            small
        ))
        .plaintext
            == b"after oversized opening message"
    );
}

#[test]
fn maximum_and_empty_plaintext_roundtrip_without_truncation() {
    let (mut alice, mut bob, _) = established();
    for size in [0, MAX_PLAINTEXT_BYTES] {
        let sent = must(encrypt(alice, vec![7; 32], vec![42; size]));
        assert!(sent.wire.body.len() <= MAX_WIRE_BYTES);
        let received = must(decrypt(bob, vec![9; 32], sent.wire));
        assert!(received.plaintext.len() == size && received.plaintext.iter().all(|v| *v == 42));
        alice = sent.session_pickle;
        bob = received.session_pickle;
    }
}

#[test]
fn errors_never_include_provider_details_or_input() {
    assert!(NativeCryptoError::InvalidInput.to_string() == "Invalid native crypto input");
    assert!(NativeCryptoError::OperationFailed.to_string() == "Native crypto operation failed");
    assert!(
        NativeCryptoError::MessageNotOpened.to_string() == "Incoming native message not opened"
    );
}
