//! Real-provider tests using newly generated synthetic accounts; no app secrets.
//! Deliberately avoid Debug-printing messages, keys or encrypted state on failure.
use thalassa_vodozemac_native::{
    AccountState, MAX_PICKLE_BYTES, MAX_PLAINTEXT_BYTES, MAX_WIRE_BYTES, NativeCryptoError,
    WireMessage, decrypt, encrypt, new_account, open_session, start_session,
};
use vodozemac::olm::{Account, AccountPickle, OlmMessage, Session, SessionConfig, SessionPickle};

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
        Err(NativeCryptoError::OperationFailed)
    ));
    let received = must(decrypt(bob, vec![9; 32], sent.wire.clone()));
    assert!(received.plaintext == b"authenticated");
    assert!(matches!(
        decrypt(received.session_pickle, vec![9; 32], sent.wire),
        Err(NativeCryptoError::OperationFailed)
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
        assert!(decrypt(bob.clone(), vec![9; 32], messages[index].clone()).is_err());
    }
}

#[test]
fn wrong_pickle_key_and_corrupted_pickle_reject() {
    let (alice, bob, _) = established();
    assert!(encrypt(alice.clone(), vec![8; 32], b"no".to_vec()).is_err());
    let sent = must(encrypt(alice.clone(), vec![7; 32], b"yes".to_vec()));
    assert!(decrypt(bob, vec![8; 32], sent.wire).is_err());
    let mut corrupted = alice.into_bytes();
    corrupted[8] = if corrupted[8] == b'A' { b'B' } else { b'A' };
    let corrupted = String::from_utf8(corrupted).expect("base64 ASCII fixture");
    assert!(encrypt(corrupted, vec![7; 32], b"no".to_vec()).is_err());
    let (account, peer) = accounts();
    assert!(
        start_session(
            account.account_pickle,
            vec![8; 32],
            peer.identity_curve,
            peer.one_time_key
        )
        .is_err()
    );
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
    assert!(
        open_session(
            bob.account_pickle.clone(),
            vec![9; 32],
            other.identity_curve,
            sent.wire.clone()
        )
        .is_err()
    );
    let mut tampered = sent.wire.clone();
    *tampered.body.last_mut().expect("synthetic opening has MAC") ^= 1;
    assert!(
        open_session(
            bob.account_pickle.clone(),
            vec![9; 32],
            alice.identity_curve.clone(),
            tampered
        )
        .is_err()
    );
    let opened = must(open_session(
        bob.account_pickle,
        vec![9; 32],
        alice.identity_curve.clone(),
        sent.wire.clone(),
    ));
    assert!(opened.plaintext == b"opening");
    // New account snapshot consumed the single prekey. Reusing it is rejected.
    assert!(
        open_session(
            opened.account_pickle,
            vec![9; 32],
            alice.identity_curve,
            sent.wire
        )
        .is_err()
    );
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
    assert!(decrypt(opened.session_pickle.clone(), vec![9; 32], altered).is_err());
    assert!(must(decrypt(opened.session_pickle, vec![9; 32], second.wire)).plaintext == b"second");
}

#[test]
fn malformed_types_sizes_and_keys_reject_before_provider_work() {
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
            Err(NativeCryptoError::InvalidInput)
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
        Err(NativeCryptoError::InvalidInput)
    ));
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
}
