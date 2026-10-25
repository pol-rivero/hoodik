pub(crate) mod permission;
pub(crate) mod repository;

pub mod data;
pub mod routes;
pub mod trash;

#[cfg(test)]
mod test;

#[cfg(any(test, feature = "mock"))]
pub mod mock;
