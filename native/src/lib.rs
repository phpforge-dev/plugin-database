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
    pub fn confined(root: &std::path::Path, input: &str) -> Res<std::path::PathBuf> {
        let root = root.canonicalize().map_err(err)?;
        let path = std::path::Path::new(input);
        let path = if path.is_absolute() {
            path.to_path_buf()
        } else {
            root.join(path)
        };
        let path = path.canonicalize().map_err(err)?;
        if !path.starts_with(&root) {
            return Err("Arquivo fora do projeto".into());
        }
        Ok(path)
    }
}

pub mod laravel_database;
