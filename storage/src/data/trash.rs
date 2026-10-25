//! Request and response shapes of the trash routes.
use ::error::AppResult;
use entity::Uuid;
use serde::{Deserialize, Serialize};
use validr::*;

use super::app_file::AppFile;

/// Body of `POST /api/storage/trash/restore` and `/purge`.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct TrashIds {
    pub ids: Option<Vec<Uuid>>,
}

impl Validation for TrashIds {
    fn rules(&self) -> Vec<Rule<Self>> {
        vec![Rule::new("ids", |obj: &TrashIds, error| {
            if obj.ids.as_ref().is_none_or(|ids| ids.is_empty()) {
                error.add("required")
            }
        })]
    }
}

impl TrashIds {
    /// The validated ids, deduplicated in request order.
    pub fn into_value(self) -> AppResult<Vec<Uuid>> {
        let data = self.validate()?;
        let mut ids = data.ids.unwrap_or_default();
        let mut seen = std::collections::HashSet::new();
        ids.retain(|id| seen.insert(*id));

        Ok(ids)
    }
}

/// Query of `GET /api/storage/trash`.
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
pub struct TrashQuery {
    /// Same meaning as on `GET /api/storage`: withhold the thumbnail blobs.
    pub compact: Option<bool>,
}

/// Response of `GET /api/storage/trash`.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct TrashList {
    pub items: Vec<AppFile>,
}

/// Response of `POST /api/storage/trash/restore`.
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
pub struct RestoreResponse {
    pub restored: Vec<Restored>,
    /// Left in the trash: an active sibling with the same name exists where
    /// the item would land.
    pub conflicts: Vec<Uuid>,
    /// Not a restorable trash root of the caller.
    pub missing: Vec<Uuid>,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
pub struct Restored {
    pub id: Uuid,
    /// The parent the item lives in now.
    pub file_id: Option<Uuid>,
    /// The original parent was unusable, so the item went to the caller's root.
    pub relocated: bool,
}
