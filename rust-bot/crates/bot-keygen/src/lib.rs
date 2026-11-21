//! Reusable Ed25519 keypair generation for Binance WebSocket API `session.logon`.
//!
//! The `bot-keygen` binary and the unified `apexrust` CLI both call into this
//! module so the PEM encoding, permission handling and fingerprints stay
//! identical no matter which entry point is used.

use base64::Engine as _;
use ed25519_dalek::SigningKey;
use rand_core::OsRng;
use sha2::{Digest, Sha256};
use std::fmt;
use std::fs;
use std::path::{Path, PathBuf};

/// Options mirrored 1:1 by the CLI flags of `bot-keygen keygen` / `apexrust keygen`.
#[derive(Debug, Clone)]
pub struct KeygenOptions {
    /// `testnet` or `production`; only used for the default filename.
    pub environment: String,
    /// Directory that receives the PEM files. Created with `0700`.
    pub out_dir: PathBuf,
    /// Optional filename suffix (e.g. `main`, `scalper`).
    pub label: String,
    /// Overwrite an existing keypair instead of failing.
    pub force: bool,
}

impl Default for KeygenOptions {
    fn default() -> Self {
        Self {
            environment: "testnet".to_string(),
            out_dir: PathBuf::from("rust-bot/keys"),
            label: String::new(),
            force: false,
        }
    }
}

/// Result of a successful key generation.
#[derive(Debug, Clone)]
pub struct GeneratedKeypair {
    pub private_path: PathBuf,
    pub public_path: PathBuf,
    pub public_pem: String,
    /// SHA-256 of the SubjectPublicKeyInfo DER, first 8 bytes, hex encoded.
    pub fingerprint: String,
    /// Raw 32-byte public key, base64 encoded.
    pub public_key_base64: String,
}

#[derive(Debug)]
pub enum KeygenError {
    Io(String),
    AlreadyExists(PathBuf),
    InvalidPublicKeyPem(String),
}

impl fmt::Display for KeygenError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            KeygenError::Io(msg) => write!(f, "{msg}"),
            KeygenError::AlreadyExists(path) => write!(
                f,
                "{} already exists. Re-run with --force to rotate the key.",
                path.display()
            ),
            KeygenError::InvalidPublicKeyPem(msg) => {
                write!(f, "Invalid PEM public key: {msg}")
            }
        }
    }
}

impl std::error::Error for KeygenError {}

impl From<std::io::Error> for KeygenError {
    fn from(err: std::io::Error) -> Self {
        KeygenError::Io(err.to_string())
    }
}

/// Normalizes an environment string, accepting `prod`/`production` and `test`/`testnet`.
pub fn normalize_environment(raw: &str) -> String {
    match raw.trim().to_ascii_lowercase().as_str() {
        "prod" | "production" | "mainnet" => "production".to_string(),
        _ => "testnet".to_string(),
    }
}

/// Generates a fresh Ed25519 keypair and writes both PEM files.
pub fn generate(opts: &KeygenOptions) -> Result<GeneratedKeypair, KeygenError> {
    let environment = normalize_environment(&opts.environment);
    let signing_key = SigningKey::generate(&mut OsRng);
    let verifying_key = signing_key.verifying_key();
    let seed = signing_key.to_bytes();
    let public = verifying_key.to_bytes();

    // RFC 8410 PKCS#8 v1: 302e020100300506032b657004220420 || seed
    let mut pkcs8 = hex("302e020100300506032b657004220420");
    pkcs8.extend_from_slice(&seed);
    // RFC 8410 SubjectPublicKeyInfo: 302a300506032b6570032100 || public
    let mut spki = hex("302a300506032b6570032100");
    spki.extend_from_slice(&public);

    fs::create_dir_all(&opts.out_dir)?;
    set_mode(&opts.out_dir, 0o700);

    let suffix = if opts.label.trim().is_empty() {
        String::new()
    } else {
        format!("-{}", opts.label.trim())
    };
    let private_path = opts
        .out_dir
        .join(format!("ed25519-{environment}{suffix}.pem"));
    let public_path = opts
        .out_dir
        .join(format!("ed25519-{environment}{suffix}.pub.pem"));

    if private_path.exists() && !opts.force {
        return Err(KeygenError::AlreadyExists(private_path));
    }

    let private_pem = pem_wrap("PRIVATE KEY", &pkcs8);
    let public_pem = pem_wrap("PUBLIC KEY", &spki);

    fs::write(&private_path, private_pem)?;
    set_mode(&private_path, 0o600);
    fs::write(&public_path, &public_pem)?;
    set_mode(&public_path, 0o644);

    Ok(GeneratedKeypair {
        private_path,
        public_path,
        public_pem,
        fingerprint: fingerprint_from_public_bytes(&public),
        public_key_base64: base64::engine::general_purpose::STANDARD.encode(public),
    })
}

/// Short fingerprint for a raw 32-byte Ed25519 public key.
pub fn fingerprint_from_public_bytes(public: &[u8]) -> String {
    let mut spki = hex("302a300506032b6570032100");
    spki.extend_from_slice(public);
    fingerprint_from_spki(&spki)
}

/// PEM encoded SubjectPublicKeyInfo for a raw 32-byte Ed25519 public key.
pub fn public_pem_from_bytes(public: &[u8]) -> String {
    let mut spki = hex("302a300506032b6570032100");
    spki.extend_from_slice(public);
    pem_wrap("PUBLIC KEY", &spki)
}

/// Computes the short fingerprint (16 hex chars) from a PEM encoded SPKI public key.
pub fn fingerprint_from_public_pem(pem: &str) -> Result<String, KeygenError> {
    let der = pem_to_der(pem)?;
    Ok(fingerprint_from_spki(&der))
}

/// Reads a PEM file and returns its short fingerprint.
pub fn fingerprint_from_public_pem_file(path: impl AsRef<Path>) -> Result<String, KeygenError> {
    let pem = fs::read_to_string(path.as_ref())?;
    fingerprint_from_public_pem(&pem)
}

fn fingerprint_from_spki(spki: &[u8]) -> String {
    hex_string(&Sha256::digest(spki)[..8])
}

fn pem_to_der(pem: &str) -> Result<Vec<u8>, KeygenError> {
    let body: String = pem
        .lines()
        .map(str::trim)
        .filter(|line| !line.is_empty() && !line.starts_with("-----"))
        .collect::<Vec<_>>()
        .join("");
    if body.is_empty() {
        return Err(KeygenError::InvalidPublicKeyPem(
            "no base64 body found".to_string(),
        ));
    }
    base64::engine::general_purpose::STANDARD
        .decode(body.as_bytes())
        .map_err(|e| KeygenError::InvalidPublicKeyPem(e.to_string()))
}

fn pem_wrap(label: &str, der: &[u8]) -> String {
    let body = base64::engine::general_purpose::STANDARD.encode(der);
    let mut out = format!("-----BEGIN {label}-----\n");
    for chunk in body.as_bytes().chunks(64) {
        out.push_str(&String::from_utf8_lossy(chunk));
        out.push('\n');
    }
    out.push_str(&format!("-----END {label}-----\n"));
    out
}

fn hex(raw: &str) -> Vec<u8> {
    (0..raw.len())
        .step_by(2)
        .map(|i| u8::from_str_radix(&raw[i..i + 2], 16).expect("valid hex literal"))
        .collect()
}

fn hex_string(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

#[cfg(unix)]
fn set_mode(path: &Path, mode: u32) {
    use std::os::unix::fs::PermissionsExt;
    if let Ok(meta) = fs::metadata(path) {
        let mut perms = meta.permissions();
        perms.set_mode(mode);
        let _ = fs::set_permissions(path, perms);
    }
}

#[cfg(not(unix))]
fn set_mode(_path: &Path, _mode: u32) {}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_dir(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "bot-keygen-test-{tag}-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn generate_writes_pem_files_and_matching_fingerprint() {
        let dir = temp_dir("generate");
        let keypair = generate(&KeygenOptions {
            environment: "testnet".into(),
            out_dir: dir.clone(),
            label: "unit".into(),
            force: false,
        })
        .expect("keygen should succeed");

        assert!(keypair.private_path.exists());
        assert!(keypair.public_path.exists());
        assert!(keypair.public_pem.starts_with("-----BEGIN PUBLIC KEY-----"));
        assert_eq!(
            fingerprint_from_public_pem_file(&keypair.public_path).unwrap(),
            keypair.fingerprint
        );
        assert_eq!(keypair.fingerprint.len(), 16);
        assert_ne!(
            fingerprint_from_public_pem(&keypair.public_pem).unwrap(),
            "0000000000000000"
        );
        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn existing_key_requires_force() {
        let dir = temp_dir("exists");
        let opts = KeygenOptions {
            environment: "production".into(),
            out_dir: dir.clone(),
            label: String::new(),
            force: false,
        };
        generate(&opts).unwrap();
        let err = generate(&opts).expect_err("second run must refuse");
        assert!(matches!(err, KeygenError::AlreadyExists(_)));
        assert!(generate(&KeygenOptions {
            force: true,
            ..opts
        })
        .is_ok());
        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn environment_normalization_and_invalid_pem() {
        assert_eq!(normalize_environment("prod"), "production");
        assert_eq!(normalize_environment(" TESTNET "), "testnet");
        assert!(fingerprint_from_public_pem("not a pem").is_err());
    }
}
