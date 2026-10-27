//! Request and response shapes of `GET /api/storage/largest`.
use serde::{Deserialize, Serialize};

use super::app_file::AppFile;

/// Query of `GET /api/storage/largest`.
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
pub struct LargestQuery {
    pub limit: Option<u64>,
}

impl LargestQuery {
    pub const DEFAULT_LIMIT: u64 = 20;
    pub const MAX_LIMIT: u64 = 100;

    pub fn limit(&self) -> u64 {
        self.limit
            .unwrap_or(Self::DEFAULT_LIMIT)
            .clamp(1, Self::MAX_LIMIT)
    }
}

/// Response of `GET /api/storage/largest`.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct LargestList {
    pub items: Vec<AppFile>,
}
