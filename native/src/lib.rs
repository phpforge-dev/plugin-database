pub mod database;
pub use database::*;
mod git {
    pub fn s(v: &serde_json::Value) -> Result<&str, String> {
        v.as_str().ok_or_else(|| "Expected string".into())
    }
}
mod workspace {
    pub type Res<T> = Result<T, String>;
    pub fn err(e: impl std::fmt::Display) -> String {
        e.to_string()
    }
    pub fn hash(data: impl AsRef<[u8]>) -> String {
        use sha2::{Digest, Sha256};
        format!("{:x}", Sha256::digest(data.as_ref()))
    }
}
