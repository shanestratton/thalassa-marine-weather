//! Stateless, bounded native research boundary for unchanged vodozemac Olm v1.
//!
//! No files, Keychain, network, device directory, app registration or durable
//! mutations happen here. The native caller must authenticate peer identity,
//! bind snapshots to owner/peer/session IDs, and atomically commit every returned
//! snapshot plus the exact outgoing wire before exposing an operation's success.
//! Reusing old snapshots repeats ratchet state: persistence is not optional.
//!
//! Rust-owned input keys and intermediate plaintext are zeroized on drop. This
//! is NOT a complete memory-erasure guarantee: UniFFI, Swift, provider internals,
//! and the returned plaintext have copies outside these buffers' control.

use vodozemac::{
    Curve25519PublicKey,
    olm::{Account, AccountPickle, OlmMessage, Session, SessionConfig, SessionPickle},
};
use zeroize::Zeroizing;

uniffi::setup_scaffolding!();

pub const MAX_PLAINTEXT_BYTES: usize = 64 * 1024;
pub const MAX_WIRE_BYTES: usize = MAX_PLAINTEXT_BYTES + 1024;
// Leave room for two pickles, one wire and metadata in the 1 MiB native snapshot.
pub const MAX_PICKLE_BYTES: usize = 256 * 1024;

// Never return formatted provider errors, raw input, plaintext or secret state.
#[derive(Debug, thiserror::Error, uniffi::Error)]
pub enum NativeCryptoError {
    #[error("Invalid native crypto input")]
    InvalidInput,
    #[error("Native crypto operation failed")]
    OperationFailed,
}

#[derive(Clone, uniffi::Record)]
pub struct WireMessage {
    pub message_type: u32,
    pub body: Vec<u8>,
}

#[derive(uniffi::Record)]
pub struct AccountState {
    pub account_pickle: String,
    pub identity_curve: String,
    pub signing_key: String,
    pub one_time_key: String,
}

#[derive(uniffi::Record)]
pub struct SessionState {
    pub session_pickle: String,
    pub session_id: String,
}

#[derive(uniffi::Record)]
pub struct EncryptedMessage {
    pub session_pickle: String,
    pub session_id: String,
    pub wire: WireMessage,
}

#[derive(uniffi::Record)]
pub struct OpenedSession {
    pub account_pickle: String,
    pub session_pickle: String,
    pub session_id: String,
    pub plaintext: Vec<u8>,
}

#[derive(uniffi::Record)]
pub struct DecryptedMessage {
    pub session_pickle: String,
    pub session_id: String,
    pub plaintext: Vec<u8>,
}

fn key_bytes(key: &[u8]) -> Result<&[u8; 32], NativeCryptoError> {
    key.try_into().map_err(|_| NativeCryptoError::InvalidInput)
}

fn bounded_pickle(pickle: &str) -> Result<(), NativeCryptoError> {
    if pickle.is_empty() || pickle.len() > MAX_PICKLE_BYTES {
        Err(NativeCryptoError::InvalidInput)
    } else {
        Ok(())
    }
}

fn curve_key(encoded: &str) -> Result<Curve25519PublicKey, NativeCryptoError> {
    // Exactly one canonical representation for a 32-byte public key.
    if encoded.len() != 43 {
        return Err(NativeCryptoError::InvalidInput);
    }
    let key =
        Curve25519PublicKey::from_base64(encoded).map_err(|_| NativeCryptoError::InvalidInput)?;
    if key.to_base64() != encoded {
        return Err(NativeCryptoError::InvalidInput);
    }
    Ok(key)
}

fn account_from(pickle: &str, key: &[u8; 32]) -> Result<Account, NativeCryptoError> {
    bounded_pickle(pickle)?;
    let pickle = AccountPickle::from_encrypted(pickle, key)
        .map_err(|_| NativeCryptoError::OperationFailed)?;
    Ok(Account::from_pickle(pickle))
}

fn session_from(pickle: &str, key: &[u8; 32]) -> Result<Session, NativeCryptoError> {
    bounded_pickle(pickle)?;
    let pickle = SessionPickle::from_encrypted(pickle, key)
        .map_err(|_| NativeCryptoError::OperationFailed)?;
    let session = Session::from_pickle(pickle);
    if session.session_config() != SessionConfig::version_1() {
        return Err(NativeCryptoError::OperationFailed);
    }
    Ok(session)
}

fn store_account(account: &Account, key: &[u8; 32]) -> Result<String, NativeCryptoError> {
    let pickle = account.pickle().encrypt(key);
    bounded_pickle(&pickle).map_err(|_| NativeCryptoError::OperationFailed)?;
    Ok(pickle)
}

fn store_session(session: &Session, key: &[u8; 32]) -> Result<String, NativeCryptoError> {
    let pickle = session.pickle().encrypt(key);
    bounded_pickle(&pickle).map_err(|_| NativeCryptoError::OperationFailed)?;
    Ok(pickle)
}

fn decode_wire(wire: WireMessage) -> Result<OlmMessage, NativeCryptoError> {
    if wire.message_type > 1 || wire.body.is_empty() || wire.body.len() > MAX_WIRE_BYTES {
        return Err(NativeCryptoError::InvalidInput);
    }
    OlmMessage::from_parts(wire.message_type as usize, &wire.body)
        .map_err(|_| NativeCryptoError::OperationFailed)
}

/// Synthetic single-prekey account. Does not publish or authenticate anything.
#[uniffi::export]
pub fn new_account(pickle_key: Vec<u8>) -> Result<AccountState, NativeCryptoError> {
    let pickle_key = Zeroizing::new(pickle_key);
    let key = key_bytes(&pickle_key)?;
    let mut account = Account::new();
    account.generate_one_time_keys(1);
    let one_time_key = account
        .one_time_keys()
        .values()
        .next()
        .ok_or(NativeCryptoError::OperationFailed)?
        .to_base64();
    // Retain the private OTK in the encrypted pickle, but don't re-publish it.
    account.mark_keys_as_published();
    Ok(AccountState {
        account_pickle: store_account(&account, key)?,
        identity_curve: account.curve25519_key().to_base64(),
        signing_key: account.ed25519_key().to_base64(),
        one_time_key,
    })
}

/// Both peer keys must already be authenticated and pinned by the native caller.
#[uniffi::export]
pub fn start_session(
    account_pickle: String,
    pickle_key: Vec<u8>,
    peer_identity: String,
    peer_prekey: String,
) -> Result<SessionState, NativeCryptoError> {
    let pickle_key = Zeroizing::new(pickle_key);
    let key = key_bytes(&pickle_key)?;
    let peer_identity = curve_key(&peer_identity)?;
    let peer_prekey = curve_key(&peer_prekey)?;
    let account = account_from(&account_pickle, key)?;
    let session = account
        .create_outbound_session(SessionConfig::version_1(), peer_identity, peer_prekey)
        .map_err(|_| NativeCryptoError::OperationFailed)?;
    Ok(SessionState {
        session_pickle: store_session(&session, key)?,
        session_id: session.session_id(),
    })
}

/// Caller must commit the returned snapshot and exact wire in one transaction.
#[uniffi::export]
pub fn encrypt(
    session_pickle: String,
    pickle_key: Vec<u8>,
    plaintext: Vec<u8>,
) -> Result<EncryptedMessage, NativeCryptoError> {
    let pickle_key = Zeroizing::new(pickle_key);
    let plaintext = Zeroizing::new(plaintext);
    let key = key_bytes(&pickle_key)?;
    if plaintext.len() > MAX_PLAINTEXT_BYTES {
        return Err(NativeCryptoError::InvalidInput);
    }
    let mut session = session_from(&session_pickle, key)?;
    let message = session
        .encrypt(plaintext.as_slice())
        .map_err(|_| NativeCryptoError::OperationFailed)?;
    let (message_type, body) = message.to_parts();
    if message_type > 1 || body.len() > MAX_WIRE_BYTES {
        return Err(NativeCryptoError::OperationFailed);
    }
    Ok(EncryptedMessage {
        session_pickle: store_session(&session, key)?,
        session_id: session.session_id(),
        wire: WireMessage {
            message_type: message_type as u32,
            body,
        },
    })
}

/// Requires an externally pinned sender; never adopts the identity in the wire.
/// Caller must atomically persist BOTH account OTK consumption and new session.
#[uniffi::export]
pub fn open_session(
    account_pickle: String,
    pickle_key: Vec<u8>,
    pinned_sender_curve: String,
    wire: WireMessage,
) -> Result<OpenedSession, NativeCryptoError> {
    let pickle_key = Zeroizing::new(pickle_key);
    let key = key_bytes(&pickle_key)?;
    let sender = curve_key(&pinned_sender_curve)?;
    let OlmMessage::PreKey(prekey) = decode_wire(wire)? else {
        return Err(NativeCryptoError::InvalidInput);
    };
    let mut account = account_from(&account_pickle, key)?;
    let opened = account
        .create_inbound_session(SessionConfig::version_1(), sender, &prekey)
        .map_err(|_| NativeCryptoError::OperationFailed)?;
    let plaintext = Zeroizing::new(opened.plaintext);
    if plaintext.len() > MAX_PLAINTEXT_BYTES {
        return Err(NativeCryptoError::OperationFailed);
    }
    Ok(OpenedSession {
        account_pickle: store_account(&account, key)?,
        session_pickle: store_session(&opened.session, key)?,
        session_id: opened.session.session_id(),
        plaintext: plaintext.to_vec(),
    })
}

/// Caller must compare returned session ID to its authenticated snapshot metadata
/// and commit the advanced state and received-message record atomically.
#[uniffi::export]
pub fn decrypt(
    session_pickle: String,
    pickle_key: Vec<u8>,
    wire: WireMessage,
) -> Result<DecryptedMessage, NativeCryptoError> {
    let pickle_key = Zeroizing::new(pickle_key);
    let key = key_bytes(&pickle_key)?;
    let wire = decode_wire(wire)?;
    let mut session = session_from(&session_pickle, key)?;
    // Upstream decrypt authenticates the inner message; on an existing session
    // it does not compare the surrounding prekey header to that session.
    if let OlmMessage::PreKey(prekey) = &wire {
        if prekey.session_keys() != session.session_keys() {
            return Err(NativeCryptoError::OperationFailed);
        }
    }
    let plaintext = Zeroizing::new(
        session
            .decrypt(&wire)
            .map_err(|_| NativeCryptoError::OperationFailed)?,
    );
    if plaintext.len() > MAX_PLAINTEXT_BYTES {
        return Err(NativeCryptoError::OperationFailed);
    }
    Ok(DecryptedMessage {
        session_pickle: store_session(&session, key)?,
        session_id: session.session_id(),
        plaintext: plaintext.to_vec(),
    })
}
